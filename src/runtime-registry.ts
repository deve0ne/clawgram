import type { RuntimeMap } from './types';

// OpenClaw may register the channel again while materializing tools for an
// isolated turn. Keep the connected clients at module scope so the new channel
// facade sees the same account runtimes as the long-lived gateway lifecycle.
export const pluginRuntimes: RuntimeMap = new Map();

/**
 * Stop one captured connection without letting its delayed cleanup erase a
 * newer connection for the same account.
 */
export async function stopRuntimeIfOwned<T extends { stop(): Promise<void> }>(
  runtimes: Map<string, T>,
  accountId: string,
  runtime: T,
  cleanupOwnedRecord: () => void,
): Promise<boolean> {
  await runtime.stop();
  if (runtimes.get(accountId) !== runtime) {
    return false;
  }

  runtimes.delete(accountId);
  cleanupOwnedRecord();
  return true;
}
