import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Api } from "telegram";
import { GramJsClientManager } from "../src/gramjs-client";

import { readAccountDmMembershipChats, senderSharesConfiguredChat } from "../src/dm-membership";

describe("direct-message membership gate", () => {
  it("distinguishes an absent gate from an explicitly empty one", () => {
    assert.equal(readAccountDmMembershipChats({}, "default"), undefined);
    assert.deepEqual(readAccountDmMembershipChats({
      channels: { clawgram: { accounts: { default: { dmMembershipChats: [] } } } },
    }, "default"), []);
  });

  it("normalizes and deduplicates configured chat ids", () => {
    assert.deepEqual(readAccountDmMembershipChats({
      channels: { clawgram: { accounts: { default: { dmMembershipChats: [ " -1001 ", -1001, "" ] } } } },
    }, "default"), [ "-1001" ]);
  });

  it("admits a sender found in any configured chat", async () => {
    const seen: string[] = [];
    const allowed = await senderSharesConfiguredChat({
      senderId: "42",
      chats: [ "-1001", "-1002" ],
      isParticipant: async (target, senderId) => {
        assert.equal(senderId, "42");
        seen.push(target);
        return target === "-1002";
      },
    });
    assert.equal(allowed, true);
    assert.deepEqual(seen, [ "-1001", "-1002" ]);
  });

  it("fails closed when every lookup fails", async () => {
    const errors: string[] = [];
    assert.equal(await senderSharesConfiguredChat({
      senderId: "42",
      chats: [ "-1001" ],
      isParticipant: async () => { throw new Error("CHANNEL_PRIVATE"); },
      onLookupError: ({ error }) => errors.push(error),
    }), false);
    assert.deepEqual(errors, [ "CHANNEL_PRIVATE" ]);
  });
});

describe("Telegram membership lookup", () => {
  function manager(peer: Record<string, unknown>, invoke: (request: any) => Promise<any>) {
    const value = Object.create(GramJsClientManager.prototype) as GramJsClientManager;
    (value as any).resolvePeer = async (target: string) => ({
      peer: target === "42" ? { userId: "42" } : peer,
    });
    (value as any).client = { invoke };
    return value;
  }

  it("queries the specific member of a supergroup instead of the first 1000 users", async () => {
    const value = manager({ channelId: "9" }, async (request) => {
      assert.ok(request instanceof Api.channels.GetParticipant);
      assert.equal((request.participant as any).userId, "42");
      return { participant: new Api.ChannelParticipant({ userId: "42", date: 0 } as any) };
    });
    assert.equal(await value.isChatParticipant("-1009", "42"), true);
  });

  it("rejects departed and kicked members but admits a restricted current member", async () => {
    for (const [participant, expected] of [
      [new Api.ChannelParticipantLeft({ peer: new Api.PeerUser({ userId: "42" } as any) }), false],
      [new Api.ChannelParticipantBanned({ peer: new Api.PeerUser({ userId: "42" } as any), left: true, bannedRights: {} } as any), false],
      [new Api.ChannelParticipantBanned({ peer: new Api.PeerUser({ userId: "42" } as any), bannedRights: { viewMessages: true } } as any), false],
      [new Api.ChannelParticipantBanned({ peer: new Api.PeerUser({ userId: "42" } as any), bannedRights: { sendMessages: true } } as any), true],
    ] as const) {
      const value = manager({ channelId: "9" }, async () => ({ participant }));
      assert.equal(await value.isChatParticipant("-1009", "42"), expected);
    }
  });

  it("distinguishes a non-member from an unavailable lookup", async () => {
    const value = manager({ channelId: "9" }, async () => {
      throw Object.assign(new Error("missing"), { errorMessage: "USER_NOT_PARTICIPANT" });
    });
    assert.equal(await value.isChatParticipant("-1009", "42"), false);
    const unavailable = manager({ channelId: "9" }, async () => { throw new Error("FLOOD_WAIT"); });
    await assert.rejects(() => unavailable.isChatParticipant("-1009", "42"), /FLOOD_WAIT/);
  });

  it("uses the complete basic-group roster and refuses an unavailable roster", async () => {
    const value = manager({ chatId: "9" }, async (request) => {
      assert.ok(request instanceof Api.messages.GetFullChat);
      return { fullChat: { participants: new Api.ChatParticipants({ participants: [{ userId: "42" }] } as any) } };
    });
    assert.equal(await value.isChatParticipant("-9", "42"), true);
    assert.equal(await value.isChatParticipant("-9", "43"), false);
    const unavailable = manager({ chatId: "9" }, async () => ({ fullChat: {} }));
    await assert.rejects(() => unavailable.isChatParticipant("-9", "42"), /roster/);
  });

  it("does not treat a private conversation as a membership group", async () => {
    const value = manager({ userId: "9" }, async () => { throw new Error("must not call"); });
    await assert.rejects(() => value.isChatParticipant("9", "42"), /group or channel/);
  });
});
