import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  resolveAgentDirForMedia,
  resolveBoundAgentIdForMedia,
  understandAttachmentFile,
} from "../src/attachments";

describe("media understanding uses the routed agent", () => {
  it("passes the routed agent directory to image understanding", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "clawgram-agent-route-"));
    const agentDir = path.join(stateDir, "agents", "orphea", "agent");
    mkdirSync(agentDir, { recursive: true });
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      let receivedAgentDir: string | undefined;
      const text = await understandAttachmentFile({
        runtime: {
          mediaUnderstanding: {
            describeImageFile: async (input: { agentDir?: string }) => {
              receivedAgentDir = input.agentDir;
              return { text: "афиша" };
            },
            transcribeAudioFile: async () => ({ text: "unused" }),
          },
        } as any,
        cfg: {},
        filePath: path.join(stateDir, "poster.webp"),
        mimeType: "image/webp",
        understanding: "description",
        agentId: "orphea",
      });

      assert.equal(text, "афиша");
      assert.equal(receivedAgentDir, agentDir);
      assert.notEqual(receivedAgentDir, path.join(stateDir, "agents", "main", "agent"));
    } finally {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not invent a main agent when the route is absent", () => {
    assert.equal(resolveAgentDirForMedia(undefined, os.tmpdir()), undefined);
  });

  it("recovers the exact account binding for fetch-media", () => {
    const cfg = {
      bindings: [
        { agentId: "fallback", match: { channel: "clawgram", accountId: "*" } },
        { agentId: "orphea", match: { channel: "clawgram", accountId: "orphea" } },
      ],
    };

    assert.equal(resolveBoundAgentIdForMedia(cfg, "orphea"), "orphea");
    assert.equal(resolveBoundAgentIdForMedia(cfg, "another"), "fallback");
  });
});
