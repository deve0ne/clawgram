import assert from 'node:assert/strict';
import test from 'node:test';

import plugin from '../src/index';
import { pluginRuntimes, stopRuntimeIfOwned } from '../src/runtime-registry';

function registerChannel(): any {
  let channel: unknown;
  plugin.register({
    registerCli() {},
    registerChannel(input: { plugin: unknown }) {
      channel = input.plugin;
    },
    runtime: undefined,
  });
  return channel;
}

test('re-registering the plugin keeps connected account runtimes', async (t) => {
  const sends: Array<Record<string, unknown>> = [];
  pluginRuntimes.clear();
  t.after(() => pluginRuntimes.clear());

  registerChannel();
  pluginRuntimes.set('orphea', {
    sendText: async (args: Record<string, unknown>) => {
      sends.push(args);
      return { id: 42 };
    },
  } as any);

  const reRegistered = registerChannel();
  await reRegistered.actions.handleAction({
    action: "send",
    params: { target: '-5580190999', message: 'digest' },
    cfg: { channels: { clawgram: { accounts: { orphea: {} } } } },
    accountId: 'orphea',
  });

  assert.equal(sends.length, 1);
});

test('late cleanup cannot remove a replacement runtime or its account record', async () => {
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const runtimes = new Map<string, any>();
  const oldRuntime = { stop: async () => stopGate };
  const replacement = { stop: async () => undefined };
  let ownedCleanupCalls = 0;

  runtimes.set('orphea', oldRuntime);
  const stopping = stopRuntimeIfOwned(runtimes, 'orphea', oldRuntime, () => {
    ownedCleanupCalls += 1;
  });
  runtimes.set('orphea', replacement);
  releaseStop();

  assert.equal(await stopping, false);
  assert.equal(runtimes.get('orphea'), replacement);
  assert.equal(ownedCleanupCalls, 0);
});
