import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveStateDir } from "./state-dir";

const PROCESSING_EMOJI = "👀";
const MAX_PROCESSING_MS = 15 * 60 * 1000;

type PendingReaction = {
  target: string;
  messageId: number;
  emoji: string;
  startedAt: number;
  superseded?: boolean;
};

export type ProcessingReactionLease = { finish: () => Promise<void> };

export type ProcessingReactionDeps = {
  allowedReactions: (target: string) => Promise<readonly string[] | undefined>;
  sendReaction: (args: { target: string; messageId: number; emoji: string; remove: boolean }) => Promise<void>;
  removeIfMatches: (args: { target: string; messageId: number; emoji: string }) => Promise<boolean>;
  hasOwnReaction?: (target: string, messageId: number) => Promise<boolean>;
  onError?: (where: string, error: unknown) => void;
};

type ActiveReaction = PendingReaction & {
  owners: number;
  superseded: boolean;
  timer: ReturnType<typeof setTimeout>;
};

export function selectProcessingReaction(allowed: readonly string[] | undefined): string | undefined {
  return allowed === undefined || allowed.includes(PROCESSING_EMOJI) ? PROCESSING_EMOJI : undefined;
}

export function ownEmojiReactionFromMessage(message: any): string | undefined {
  const chosen = Array.isArray(message?.reactions?.results)
    ? message.reactions.results.find((entry: any) => entry?.chosenOrder !== undefined && entry?.chosenOrder !== null)
    : undefined;
  return chosen?.reaction?.className === "ReactionEmoji" && typeof chosen.reaction.emoticon === "string"
    ? chosen.reaction.emoticon
    : undefined;
}

export function hasOwnReactionInMessage(message: any): boolean {
  return Array.isArray(message?.reactions?.results)
    && message.reactions.results.some(
      (entry: any) => entry?.chosenOrder !== undefined && entry?.chosenOrder !== null,
    );
}

function safeAccountFileName(accountId: string): string {
  const safe = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "default";
}

export class ProcessingReactionLifecycle {
  private readonly filePath: string;
  private readonly active = new Map<string, ActiveReaction>();
  private pending = new Map<string, PendingReaction>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(accountId: string, private readonly deps: ProcessingReactionDeps, stateDir = resolveStateDir()) {
    this.filePath = path.join(stateDir, "clawgram", "processing-reactions", `${safeAccountFileName(accountId)}.json`);
  }

  async reconcile(): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      for (const [ key, reaction ] of [ ...this.pending ]) {
        if (reaction.superseded) {
          this.pending.delete(key);
          continue;
        }
        try {
          await this.deps.removeIfMatches(reaction);
          this.pending.delete(key);
        } catch (error) {
          this.deps.onError?.("startup cleanup", error);
        }
      }
      await this.save();
    });
  }

  async begin(input: { target: unknown; messageId: unknown; enabled: boolean }): Promise<ProcessingReactionLease | undefined> {
    if (!input.enabled) return undefined;
    const target = String(input.target ?? "").trim();
    const messageId = Number(input.messageId);
    if (!target || !Number.isInteger(messageId) || messageId <= 0) return undefined;

    return await this.exclusive(async () => {
      await this.load();
      const key = this.key(target, messageId);
      const existing = this.active.get(key);
      if (existing) {
        existing.owners += 1;
        return this.lease(key);
      }

      let emoji: string | undefined;
      try {
        emoji = selectProcessingReaction(await this.deps.allowedReactions(target));
      } catch (error) {
        this.deps.onError?.("allowed reactions", error);
        emoji = PROCESSING_EMOJI;
      }
      if (!emoji) return undefined;

      try {
        if (await this.deps.hasOwnReaction?.(target, messageId)) return undefined;
      } catch (error) {
        // This marker is optional. If the account's current reaction cannot be
        // observed, skip it rather than risk replacing a persistent reaction.
        this.deps.onError?.("current reaction", error);
        return undefined;
      }

      const pending: PendingReaction = { target, messageId, emoji, startedAt: Date.now() };
      this.pending.set(key, pending);
      await this.save();
      try {
        await this.deps.sendReaction({ ...pending, remove: false });
      } catch (error) {
        this.pending.delete(key);
        await this.save();
        this.deps.onError?.("send", error);
        return undefined;
      }

      const timer = setTimeout(() => {
        void this.finish(key, true).catch((error) => this.deps.onError?.("timeout cleanup", error));
      }, MAX_PROCESSING_MS);
      timer.unref?.();
      this.active.set(key, { ...pending, owners: 1, superseded: false, timer });
      return this.lease(key);
    });
  }

  /** Serializes a real agent reaction against cleanup of the temporary one. */
  async runSupersedingReaction<T>(
    input: { target: unknown; messageId: unknown },
    send: () => Promise<T>,
  ): Promise<T> {
    return await this.exclusive(async () => {
      const target = String(input.target ?? "").trim();
      const messageId = Number(input.messageId);
      const key = this.key(target, messageId);
      const current = this.active.get(key);
      const pending = this.pending.get(key);
      if (!current || !pending) return await send();

      // Persist the handoff before Telegram is changed. If the process dies
      // during an indeterminate send, restart cleanup must prefer leaving a
      // stale marker over deleting a possibly newer persistent reaction.
      current.superseded = true;
      pending.superseded = true;
      try {
        await this.save();
      } catch (error) {
        current.superseded = false;
        delete pending.superseded;
        throw error;
      }
      try {
        return await send();
      } catch (error) {
        current.superseded = false;
        delete pending.superseded;
        try {
          await this.save();
        } catch (rollbackError) {
          this.deps.onError?.("supersede rollback", rollbackError);
        }
        throw error;
      }
    });
  }

  async finishAll(): Promise<void> {
    await this.exclusive(async () => {
      for (const key of [ ...this.active.keys() ]) await this.finishUnlocked(key, true);
    });
  }

  private lease(key: string): ProcessingReactionLease {
    let finished = false;
    return {
      finish: async () => {
        if (finished) return;
        finished = true;
        await this.finish(key, false);
      },
    };
  }

  private async finish(key: string, force: boolean): Promise<void> {
    await this.exclusive(() => this.finishUnlocked(key, force));
  }

  private async finishUnlocked(key: string, force: boolean): Promise<void> {
    const current = this.active.get(key);
    if (!current) return;
    if (!force && --current.owners > 0) return;
    clearTimeout(current.timer);
    this.active.delete(key);
    if (current.superseded) {
      this.pending.delete(key);
      try {
        await this.save();
      } catch (error) {
        this.deps.onError?.("superseded cleanup", error);
      }
      return;
    }
    try {
      await this.deps.removeIfMatches(current);
      this.pending.delete(key);
      await this.save();
    } catch (error) {
      this.deps.onError?.("cleanup", error);
      // Keep the journal entry: the next process start retries cleanup.
    }
  }

  private key(target: string, messageId: number): string {
    return `${target}\n${messageId}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const decoded = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(decoded)) return;
      for (const value of decoded) {
        if (
          typeof value?.target !== "string" ||
          !Number.isInteger(value?.messageId) ||
          typeof value?.emoji !== "string" ||
          (value?.superseded !== undefined && typeof value.superseded !== "boolean")
        ) continue;
        this.pending.set(this.key(value.target, value.messageId), value as PendingReaction);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") this.deps.onError?.("read journal", error);
    }
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify([ ...this.pending.values() ])}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
