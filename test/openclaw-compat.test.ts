import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const source = (name: string) => readFileSync(path.join(__dirname, "..", "..", "src", name), "utf8");

describe("OpenClaw public SDK compatibility", () => {
  it("uses entrypoints exported by both the build SDK and OpenClaw 2026.9.2", () => {
    assert.equal(source("channel.ts").includes('openclaw/plugin-sdk/channel-runtime'), false);
    assert.equal(source("channel.ts").includes('openclaw/plugin-sdk/channel-lifecycle'), true);
    assert.equal(source("inbound-pipeline.ts").includes('openclaw/plugin-sdk/direct-dm'), false);
    assert.equal(source("inbound-pipeline.ts").includes('openclaw/plugin-sdk/channel-inbound'), true);
  });

  it("uses public dispatch receipts instead of the removed private builder", () => {
    const inbound = source("inbound-pipeline.ts");
    assert.equal(inbound.includes("buildInboundReplyDispatchBase"), false);
    assert.equal(inbound.includes("channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher"), true);
    assert.equal(inbound.includes("hasVisibleInboundReplyDispatch(dispatchResult)"), true);
    assert.equal(inbound.includes("resolveInboundReplyDispatchCounts(dispatchResult)"), true);
  });
});
