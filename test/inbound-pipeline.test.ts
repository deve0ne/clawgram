import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  agentFacingGroupBody,
  didGroupTurnDeliverVisibleReply,
  handleInboundEvent,
} from "../src/inbound-pipeline";
import {
  beginGroupTurnDelivery,
  finishGroupTurnDelivery,
  rememberTurnSend,
  resetVisibleGroupReplies,
} from "../src/group-visible-reply-guard";

describe("group turn delivery accounting", () => {
  it("counts a message.send tool result as visible for the same inbound turn", () => {
    resetVisibleGroupReplies();
    const turn = { accountId: "default", chatId: "-100123", currentMessageId: "42" };

    const emptyOwner = beginGroupTurnDelivery(turn, 1);
    assert.equal(finishGroupTurnDelivery(turn, emptyOwner, 1), false);
    const owner = beginGroupTurnDelivery(turn, 1);
    rememberTurnSend(turn, 1);
    // The echo-suppression heuristic expires after 20 seconds. Dispatch
    // ownership must survive longer because a tool can keep working after it
    // has already sent the visible answer.
    const toolSendDelivered = finishGroupTurnDelivery(turn, owner, 30_001);
    assert.equal(didGroupTurnDeliverVisibleReply({ dispatchDelivered: false, toolSendDelivered }), true);
    assert.equal(didGroupTurnDeliverVisibleReply({
      dispatchDelivered: false,
      toolSendDelivered: finishGroupTurnDelivery({ ...turn, currentMessageId: "43" }, owner),
    }), false);
  });

  it("keeps overlapping deliveries of the same update independently owned", () => {
    resetVisibleGroupReplies();
    const turn = { accountId: "default", chatId: "-100123", currentMessageId: "42" };
    const first = beginGroupTurnDelivery(turn, 1);
    rememberTurnSend(turn, 2);
    const second = beginGroupTurnDelivery(turn, 3);

    assert.equal(finishGroupTurnDelivery(turn, first, 5), true);
    assert.equal(finishGroupTurnDelivery(turn, second, 5), true);
  });

  it("keeps core dispatch receipts sufficient on their own", () => {
    resetVisibleGroupReplies();
    assert.equal(didGroupTurnDeliverVisibleReply({
      dispatchDelivered: true,
      toolSendDelivered: false,
    }), true);
  });
});

/**
 * The inbound path had no test at all until this file.
 *
 * Every incoming message goes through it, and it lived as 856 lines inside a
 * closure in `gateway.startAccount`, which builds its own Telegram client —
 * so there was nothing to put a fake behind, and the 354-outcome action probe
 * never entered it (finding A6-11). Extracting it as a function is what made
 * a test possible; this is the net that was missing.
 *
 * The move itself was proved separately and more strongly than a test can:
 * the body is line-for-line identical to the block it came from, 803 lines,
 * zero differences. What a test still has to cover is the *wiring* — the
 * twelve values the function now receives explicitly, six of which are `any`
 * and therefore unchecked by the compiler.
 */

function fakeContext(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const ctx = {
    accountId: "default",
    cfg: { channels: { clawgram: { accounts: { default: { allowFrom: [] } } } } },
    channelRuntime: {
      reply: () => { calls.push("reply"); },
      session: { get: () => undefined, set: () => {} },
      commands: { list: () => [] },
    },
    client: {},
    gram: {
      sendText: async () => { calls.push("sendText"); return { id: 1 }; },
      withTyping: async (_t: unknown, fn: () => unknown) => fn(),
      replyParseMode: undefined,
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pluginRuntime: undefined,
    runtimes: new Map(),
    selfId: "777",
    selfLabel: "@agent",
    selfUsername: "agent",
    ...over,
  };
  return { ctx, calls };
}

/**
 * Enough of the channel runtime for a group message to get past the
 * mention gate: the route, the store path and the envelope formatter are
 * what `resolveInboundRouteEnvelopeBuilderWithRuntime` asks for. The turn
 * still fails later (no session recorder), which the pipeline logs and
 * swallows — the tests below only need to observe what happened before.
 */
function pastTheGates(over: Record<string, unknown> = {}) {
  return fakeContext({
    channelRuntime: {
      reply: Object.assign(() => {}, {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: (x: unknown) => x,
      }),
      session: {
        get: () => undefined,
        set: () => {},
        resolveStorePath: () => path.join(__dirname, "..", "..", "dist-test", "probe-store"),
        readSessionUpdatedAt: () => undefined,
      },
      commands: { list: () => [] },
      routing: {
        resolveAgentRoute: () => ({
          agentId: "main", accountId: "default", matchedBy: "default",
          sessionKey: "agent:main:clawgram:group:default:-4242",
        }),
      },
    },
    ...over,
  });
}

describe("the inbound pipeline survives what the network hands it", () => {
  it("rejects non-member DMs before attachments, sender lookup or model work", async () => {
    for (const outcome of ["absent", "unavailable"] as const) {
      const calls: string[] = [];
      const { ctx } = fakeContext({
        cfg: { channels: { clawgram: { accounts: { default: {
          allowFrom: ["*"], dmMembershipChats: ["-1009"],
        } } } } },
        gram: {
          isChatParticipant: async (chat: string, sender: string) => {
            calls.push("membership");
            assert.equal(chat, "-1009");
            assert.equal(sender, "500");
            if (outcome === "unavailable") throw new Error("CHANNEL_PRIVATE");
            return false;
          },
          beginProcessingReaction: async () => { calls.push("processing"); },
          getClient: () => { calls.push("attachment"); return {}; },
        },
        client: { getEntity: async () => { calls.push("profile"); } },
        pluginRuntime: { mediaUnderstanding: {
          transcribeAudioFile: async () => { calls.push("transcribe"); },
          describeImageFile: async () => { calls.push("describe"); },
        } },
        log: { info: () => {}, warn: () => {}, error: () => { calls.push("pipeline-error"); } },
      });
      await handleInboundEvent({ message: {
        id: 8, peerId: { userId: 500 }, senderId: 500, message: "посмотри",
        media: { className: "MessageMediaPhoto", photo: { sizes: [] } },
      } }, ctx as never);
      assert.deepEqual(calls, ["membership"]);
    }
  });

  const shapes: Array<[ string, unknown ]> = [
    [ "nothing at all", undefined ],
    [ "an empty object", {} ],
    [ "a message that is not one", { message: 42 } ],
    [ "a message with no peer", { message: { id: 1, message: "привет" } } ],
    [ "a peer with no ids", { message: { id: 1, peerId: {}, message: "привет" } } ],
    [ "an outgoing message", { message: { id: 1, out: true, peerId: { userId: 5 }, message: "x" } } ],
  ];

  for (const [ what, event ] of shapes) {
    it(`does not throw on ${what}`, async () => {
      // A throw here reaches GramJS's event loop, not a caller: it would be an
      // unhandled rejection on the path of every incoming message.
      const { ctx } = fakeContext();
      await assert.doesNotReject(() => handleInboundEvent(event, ctx as never));
    });
  }

  it("the gate runs before the network: foreign groups and numeric allowFrom touch no client at all (B5-04)", async () => {
    // What used to be "reaches sender resolution" — every normalizable event
    // resolved the sender through the client before any check. Now the
    // cheap checks go first and the client is asked only when needed.
    const touched: string[] = [];
    const client = new Proxy({}, {
      get: (_t, k) => {
        if (typeof k !== "string") return undefined;
        touched.push(k);
        return async () => undefined;
      },
    });

    // A group the config does not know: dropped without a single call.
    const foreignGroup = { message: { id: 7, peerId: { channelId: 4242 }, senderId: 500, message: "статус?" } };
    await handleInboundEvent(foreignGroup, fakeContext({ client }).ctx as never);
    assert.deepEqual(touched, [], `a foreign group touched the client: ${touched.join(", ")}`);

    // A DM with a numeric-only allowFrom: the id is compared locally.
    const dm = { message: { id: 8, peerId: { userId: 500 }, senderId: 500, message: "статус?" } };
    await handleInboundEvent(dm, fakeContext({ client, cfg: { channels: { clawgram: { accounts: { default: { allowFrom: [ "999" ] } } } } } }).ctx as never);
    assert.deepEqual(touched, [], `a numeric allowFrom touched the client: ${touched.join(", ")}`);

    // allowFrom by @handle and the message carries none: the profile is fetched.
    await handleInboundEvent(dm, fakeContext({ client, cfg: { channels: { clawgram: { accounts: { default: { allowFrom: [ "@someone" ] } } } } } }).ctx as never);
    assert.ok(touched.includes("getEntity"), `an @handle allowFrom should resolve the profile; touched: ${touched.join(", ") || "nothing"}`);

    touched.length = 0;
    await handleInboundEvent({ message: { peerId: { userId: 500 }, message: "нет id" } },
      fakeContext({ client }).ctx as never);
    assert.deepEqual(touched, [], "an unnormalizable event should touch nothing");
  });

  // The turn used to get bare text and the numeric id, the greeting fell
  // back to that id, and a management chat was addressed «890975818, …»
  // all day (07.09.2026). A sender who passed the gate and arrived without
  // a profile — GramJS attaches none in a basic group — is looked up once.
  it("a sender who passed the gate and has no name is looked up; a blocked one still is not (2.27.0)", async () => {
    const touched: string[] = [];
    const client = new Proxy({}, {
      get: (_t, k) => {
        if (typeof k !== "string") return undefined;
        touched.push(k);
        return async () => ({ firstName: "Вася", lastName: "Ш." });
      },
    });
    const groupCfg = (allowFrom: string[]) => ({
      channels: { clawgram: { accounts: { default: {
        allowFrom: [],
        groups: { "-4242": { enabled: true, groupPolicy: "open", allowFrom } },
      } } } },
    });
    const nameless = { message: { id: 9, peerId: { chatId: 4242 }, senderId: 500, message: "статус?" } };

    await handleInboundEvent(nameless, pastTheGates({ client, cfg: groupCfg([ "999" ]) }).ctx as never);
    assert.deepEqual(touched, [], `a blocked sender touched the client: ${touched.join(", ")}`);

    await handleInboundEvent(nameless, pastTheGates({ client, cfg: groupCfg([ "*" ]) }).ctx as never);
    assert.ok(touched.includes("getEntity"), `an allowed nameless sender should be resolved; touched: ${touched.join(", ") || "nothing"}`);
  });

  // The lookup sits past the mention gate on purpose: under `mention` a
  // message that names nobody is dropped before the model, and B5-04's
  // point was that dropped traffic costs no call.
  it("a message the mention gate drops is not looked up either", async () => {
    const touched: string[] = [];
    const client = new Proxy({}, {
      get: (_t, k) => {
        if (typeof k !== "string") return undefined;
        touched.push(k);
        return async () => ({ firstName: "Вася" });
      },
    });
    const cfg = {
      channels: { clawgram: { accounts: { default: {
        allowFrom: [],
        groups: { "-4242": { enabled: true, groupPolicy: "mention", allowFrom: [ "*" ] } },
      } } } },
    };
    const unaddressed = { message: { id: 10, peerId: { chatId: 4242 }, senderId: 500, message: "обсудим завтра" } };
    await handleInboundEvent(unaddressed, pastTheGates({ client, cfg }).ctx as never);
    assert.equal(touched.includes("getEntity"), false, `a dropped message resolved the sender; touched: ${touched.join(", ")}`);
  });
});

describe("group typing follows the address decision", () => {
  const groupCfg = {
    channels: { clawgram: { accounts: { default: {
      allowFrom: [],
      processingReaction: true,
      groups: { "-4242": { enabled: true, groupPolicy: "open", allowFrom: [ "*" ] } },
    } } } },
  };

  async function observedTyping(message: Record<string, unknown>, cfg: unknown = groupCfg) {
    const observations: Array<{
      target: unknown;
      options: Record<string, unknown> | undefined;
      processing?: Record<string, unknown>;
      processingFinished?: boolean;
    }> = [];
    let processing: Record<string, unknown> | undefined;
    let processingFinished = false;
    const base = pastTheGates({ cfg });
    const gram = {
      ...base.ctx.gram,
      withTyping: async (target: unknown, fn: () => Promise<unknown>, options?: Record<string, unknown>) => {
        observations.push({ target, options });
        return await fn();
      },
      beginProcessingReaction: async (input: Record<string, unknown>) => {
        processing = input;
        return { finish: async () => { processingFinished = true; } };
      },
    };
    await handleInboundEvent({ message: {
      id: 20,
      peerId: { chatId: 4242 },
      senderId: 500,
      _sender: { firstName: "Вася" },
      message: "обсудим завтра",
      ...message,
    } }, { ...base.ctx, gram } as never);
    return observations[0]
      ? { ...observations[0], processing, processingFinished }
      : undefined;
  }

  it("keeps an ambient open-group turn silent", async () => {
    const observed = await observedTyping({});
    assert.equal(observed?.target, "-4242");
    assert.equal(observed?.options?.typing, false);
    assert.equal(observed?.processing, undefined);
  });

  it("shows typing for an explicit mention", async () => {
    const observed = await observedTyping({ message: "@agent, посмотри" });
    assert.equal(observed?.options?.typing, true);
    assert.deepEqual(observed?.processing, { target: "-4242", messageId: "20", enabled: true });
    assert.equal(observed?.processingFinished, true);
  });

  it("shows typing and processing when the configured identity is named without @", async () => {
    const cfg = {
      ...groupCfg,
      agents: { entries: { main: { identity: { name: "Орфея" } } } },
    };
    const observed = await observedTyping({ message: "что думает Орфея об этом?" }, cfg);
    assert.equal(observed?.options?.typing, true);
    assert.deepEqual(observed?.processing, { target: "-4242", messageId: "20", enabled: true });
    assert.equal(observed?.processingFinished, true);
  });

  it("keeps the processing marker off until the account opts in", async () => {
    const cfg = {
      channels: { clawgram: { accounts: { default: {
        allowFrom: [],
        groups: { "-4242": { enabled: true, groupPolicy: "open", allowFrom: [ "*" ] } },
      } } } },
    };
    const observed = await observedTyping({ message: "@agent, посмотри" }, cfg);
    assert.equal(observed?.processing, undefined);
  });

  it("shows typing for a reply to the agent", async () => {
    const observed = await observedTyping({
      replyTo: { replyToMsgId: 19 },
      getReplyMessage: async () => ({ id: 19, out: true, message: "мой прошлый ответ" }),
    });
    assert.equal(observed?.options?.typing, true);
    assert.equal(observed?.processing?.enabled, true);
  });

  it("keeps the forum topic on typing and read receipts", async () => {
    const observed = await observedTyping({
      message: "@agent, посмотри",
      replyTo: { forumTopic: true, replyToTopId: 77 },
    });
    assert.equal(observed?.options?.typing, true);
    assert.equal(observed?.options?.messageThreadId, 77);
    assert.equal(observed?.options?.readMessageId, 20);
    assert.deepEqual(observed?.processing, { target: "-4242", messageId: "20", enabled: true });
  });

});

describe("direct-message processing reaction", () => {
  it("starts only after membership admission and always finishes", async () => {
    const events: string[] = [];
    const base = pastTheGates({
      cfg: { channels: { clawgram: { accounts: { default: {
        allowFrom: [ "*" ], dmMembershipChats: [ "-1009" ], processingReaction: true,
      } } } } },
      gram: {
        isChatParticipant: async () => { events.push("membership"); return true; },
        getClient: () => ({}),
        withTyping: async (_target: unknown, fn: () => Promise<unknown>) => await fn(),
        beginProcessingReaction: async (input: Record<string, unknown>) => {
          events.push(`begin:${input.target}:${input.messageId}`);
          return { finish: async () => { events.push("finish"); } };
        },
      },
      client: { getEntity: async () => { events.push("profile"); return { firstName: "Вася" }; } },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    (base.ctx.channelRuntime as any).commands.shouldComputeCommandAuthorized = () => false;

    await handleInboundEvent({ message: {
      id: 8, peerId: { userId: 500 }, senderId: 500, message: "привет",
    } }, base.ctx as never);

    assert.deepEqual(events, [ "membership", "begin:500:8", "profile", "finish" ]);
  });
});

describe("what the agent reads for a group message", () => {
  it("carries the address the channel would greet with, in front of the text", () => {
    // A handle wins over a display name in `buildGroupReplyAddress`, so
    // the body says «@vasya» too — the model cannot greet a name the
    // channel then prefixes with a different handle.
    assert.equal(agentFacingGroupBody({ address: "@vasya", senderId: "500", text: "статус?" }), "@vasya: статус?");
    assert.equal(agentFacingGroupBody({ address: "Вася Ш.", senderId: "500", text: "статус?" }), "Вася Ш.: статус?");
  });

  it("falls back to a marked id, so a number is never read as a name", () => {
    assert.equal(agentFacingGroupBody({ address: undefined, senderId: "500", text: "статус?" }), "id:500: статус?");
    assert.equal(agentFacingGroupBody({ address: "  ", senderId: "500", text: "статус?" }), "id:500: статус?");
  });

  it("leaves the text alone when nothing at all is known", () => {
    assert.equal(agentFacingGroupBody({ address: undefined, senderId: undefined, text: "статус?" }), "статус?");
  });
});

describe("the context is wired, not merely typed", () => {
  it("every name the pipeline destructures is passed by the channel", () => {
    // Six of the twelve are `any`, so the compiler cannot catch a field the
    // caller forgot. Compare the two lists as text instead.
    const src = (f: string) => readFileSync(path.resolve(__dirname, "..", "..", "src", f), "utf8");

    const destructured = /const \{([\s\S]*?)\} = ctx;/.exec(src("inbound-pipeline.ts"));
    assert.ok(destructured, "the pipeline no longer destructures ctx — re-point this check");
    const wanted = destructured[ 1 ].split(",").map((s) => s.trim()).filter(Boolean).sort();

    const passed = /handleInboundEvent\(event, \{([\s\S]*?)\}\)/.exec(src("channel.ts"));
    assert.ok(passed, "the channel no longer calls handleInboundEvent — re-point this check");
    const given = passed[ 1 ].split(",").map((s) => s.trim().split(":")[ 0 ].trim()).filter(Boolean).sort();

    assert.deepEqual(wanted, given,
      "the pipeline asks for names the channel does not pass, or the other way round");
  });

  it("the declared type names exactly those twelve", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "..", "src", "inbound-pipeline.ts"), "utf8");
    const type = /export type InboundContext = \{([\s\S]*?)\n\};/.exec(src);
    assert.ok(type, "InboundContext is gone — re-point this check");
    const declared = [ ...type[ 1 ].matchAll(/^\s{2}([a-zA-Z]\w*)\??:/gm) ].map((m) => m[ 1 ]).sort();
    const destructured = /const \{([\s\S]*?)\} = ctx;/.exec(src)[ 1 ]
      .split(",").map((s) => s.trim()).filter(Boolean).sort();

    assert.deepEqual(declared, destructured, "the type and the destructuring disagree");
  });
});
