import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import {
  ProcessingReactionLifecycle,
  ownEmojiReactionFromMessage,
  selectProcessingReaction,
} from "../src/processing-reaction";
import { GramJsClientManager } from "../src/gramjs-client";

describe("processing reaction choice", () => {
  test("uses eyes only where Telegram permits them", () => {
    assert.equal(selectProcessingReaction(undefined), "👀");
    assert.equal(selectProcessingReaction([ "👍", "👀" ]), "👀");
    assert.equal(selectProcessingReaction([]), undefined);
    assert.equal(selectProcessingReaction([ "👍" ]), undefined);
  });

  test("reads only this account's chosen emoji", () => {
    assert.equal(ownEmojiReactionFromMessage({ reactions: { results: [
      { chosenOrder: 0, reaction: { className: "ReactionEmoji", emoticon: "👀" } },
    ] } }), "👀");
    assert.equal(ownEmojiReactionFromMessage({ reactions: { results: [
      { reaction: { className: "ReactionEmoji", emoticon: "👀" } },
    ] } }), undefined);
  });

  test("normalizes an action target before it supersedes the inbound marker", async () => {
    const manager = Object.create(GramJsClientManager.prototype) as any;
    let observed: Record<string, unknown> | undefined;
    manager.processingReactions = {
      runSupersedingReaction: async (input: Record<string, unknown>, send: () => Promise<void>) => {
        observed = input;
        await send();
      },
    };
    manager.sendReactionRaw = async () => {};

    await manager.sendReaction({ target: "clawgram:-1001:topic:77", messageId: 42, emoji: "👍", remove: false });
    assert.deepEqual(observed, { target: "-1001", messageId: 42 });
  });
});

describe("processing reaction lifecycle", () => {
  const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "clawgram-processing-"));

  test("appears before work and is cleared when work finishes", async () => {
    const dir = makeDir();
    const events: string[] = [];
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => [ "👀" ],
        sendReaction: async () => { events.push("reaction"); },
        removeIfMatches: async () => { events.push("clear"); return true; },
      }, dir);
      const lease = await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true });
      events.push("work");
      await lease?.finish();
      assert.deepEqual(events, [ "reaction", "work", "clear" ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips the optional marker when the current reaction cannot be observed", async () => {
    const dir = makeDir();
    let sent = 0;
    const errors: string[] = [];
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => [ "👀" ],
        hasOwnReaction: async () => { throw new Error("unavailable"); },
        sendReaction: async () => { sent += 1; },
        removeIfMatches: async () => true,
        onError: (where) => errors.push(where),
      }, dir);

      assert.equal(await lifecycle.begin({ target: "-1001", messageId: 5, enabled: true }), undefined);
      assert.equal(sent, 0);
      assert.deepEqual(errors, [ "current reaction" ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overlapping delivery of one update gets one marker and the last owner clears it", async () => {
    const dir = makeDir();
    let sent = 0;
    let cleared = 0;
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => { sent += 1; },
        removeIfMatches: async () => { cleared += 1; return true; },
      }, dir);
      const first = await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true });
      const second = await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true });
      assert.equal(sent, 1);
      await first?.finish();
      assert.equal(cleared, 0);
      await second?.finish();
      assert.equal(cleared, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not start for ambient group traffic or a chat without eyes", async () => {
    const dir = makeDir();
    let sent = 0;
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => [ "👍" ],
        sendReaction: async () => { sent += 1; },
        removeIfMatches: async () => true,
      }, dir);
      assert.equal(await lifecycle.begin({ target: "-1001", messageId: 42, enabled: false }), undefined);
      assert.equal(await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true }), undefined);
      assert.equal(sent, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not overwrite an existing reaction from this account", async () => {
    const dir = makeDir();
    let sent = 0;
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        hasOwnReaction: async () => true,
        sendReaction: async () => { sent += 1; },
        removeIfMatches: async () => true,
      }, dir);
      assert.equal(await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true }), undefined);
      assert.equal(sent, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a newer programmatic reaction wins even when it is also eyes", async () => {
    const dir = makeDir();
    const sent: string[] = [];
    let cleared = 0;
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async ({ emoji }) => { sent.push(emoji); },
        removeIfMatches: async () => { cleared += 1; return true; },
      }, dir);
      const lease = await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true });
      await lifecycle.runSupersedingReaction(
        { target: "-1001", messageId: 42 },
        async () => { sent.push("👀"); },
      );
      await lease?.finish();
      assert.deepEqual(sent, [ "👀", "👀" ]);
      assert.equal(cleared, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart never removes a newer reaction after a superseding send", async () => {
    const dir = makeDir();
    let cleanupChecks = 0;
    try {
      const firstProcess = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async () => true,
      }, dir);
      await firstProcess.begin({ target: "-1001", messageId: 42, enabled: true });
      await firstProcess.runSupersedingReaction(
        { target: "-1001", messageId: 42 },
        async () => {},
      );

      const nextProcess = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async () => { cleanupChecks += 1; return true; },
      }, dir);
      await nextProcess.reconcile();
      assert.equal(cleanupChecks, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicitly failed superseding send restores normal marker cleanup", async () => {
    const dir = makeDir();
    let cleanupChecks = 0;
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async () => { cleanupChecks += 1; return true; },
      }, dir);
      const lease = await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true });
      await assert.rejects(
        lifecycle.runSupersedingReaction(
          { target: "-1001", messageId: 42 },
          async () => { throw new Error("send failed"); },
        ),
        /send failed/,
      );
      await lease?.finish();
      assert.equal(cleanupChecks, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed supersede prewrite leaves the temporary marker cleanable", async () => {
    const dir = makeDir();
    let sent = 0;
    let cleanupChecks = 0;
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async () => { cleanupChecks += 1; return true; },
      }, dir);
      const lease = await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true });
      const originalSave = (lifecycle as any).save.bind(lifecycle);
      let failNextSave = true;
      (lifecycle as any).save = async () => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("disk full");
        }
        await originalSave();
      };

      await assert.rejects(
        lifecycle.runSupersedingReaction(
          { target: "-1001", messageId: 42 },
          async () => { sent += 1; },
        ),
        /disk full/,
      );
      await lease?.finish();
      assert.equal(sent, 0);
      assert.equal(cleanupChecks, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a journal failure after superseding is reported without rejecting cleanup", async () => {
    const dir = makeDir();
    const errors: string[] = [];
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async () => true,
        onError: (where) => errors.push(where),
      }, dir);
      const lease = await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true });
      await lifecycle.runSupersedingReaction(
        { target: "-1001", messageId: 42 },
        async () => {},
      );
      (lifecycle as any).save = async () => { throw new Error("disk full"); };

      await lease?.finish();
      assert.deepEqual(errors, [ "superseded cleanup" ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed cleanup is journaled and retried after restart", async () => {
    const dir = makeDir();
    let retried = 0;
    try {
      const firstProcess = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async () => { throw new Error("offline"); },
      }, dir);
      const lease = await firstProcess.begin({ target: "-1001", messageId: 42, enabled: true });
      await lease?.finish();

      const nextProcess = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async ({ emoji }) => { retried += 1; assert.equal(emoji, "👀"); return true; },
      }, dir);
      await nextProcess.reconcile();
      assert.equal(retried, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a newer reaction is left alone and no longer journaled as ours", async () => {
    const dir = makeDir();
    let checks = 0;
    try {
      const lifecycle = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async () => { checks += 1; return false; },
      }, dir);
      const lease = await lifecycle.begin({ target: "-1001", messageId: 42, enabled: true });
      await lease?.finish();

      const nextProcess = new ProcessingReactionLifecycle("default", {
        allowedReactions: async () => undefined,
        sendReaction: async () => {},
        removeIfMatches: async () => { checks += 1; return true; },
      }, dir);
      await nextProcess.reconcile();
      assert.equal(checks, 1, "restart must not revisit a marker Telegram already replaced");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
