import { ExpiringMap } from "./expiring-map";
import { normalizeOutboundTarget } from "./helpers";

const GROUP_VISIBLE_REPLY_TTL_MS = 10 * 60 * 1000;

/** When each visible reply went out, keyed by account + chat + incoming message. */
const recentVisibleGroupReplies = new ExpiringMap<true>(GROUP_VISIBLE_REPLY_TTL_MS);

/**
 * How long after the agent's own send core's delivery of the same turn's final
 * text still counts as an echo rather than as something new.
 *
 * Measured on the live incident: `handleAction send` at 12:39:02, core's
 * delivery at 12:39:09 — seven seconds, twice in a row. Work that produces
 * genuinely new information takes far longer, and the window has to stay well
 * under that: dropping a real result is worse than letting a duplicate through.
 */
const GROUP_TURN_ECHO_WINDOW_MS = 20 * 1000;

function buildVisibleGroupReplyKey(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}): string | undefined {
  const chatId = normalizeOutboundTarget(String(input.chatId ?? "").trim());
  const currentMessageId = input.currentMessageId === null || input.currentMessageId === undefined
    ? ""
    : String(input.currentMessageId).trim();
  if (!chatId || !currentMessageId) {
    return undefined;
  }

  return [ input.accountId ?? "", chatId, currentMessageId ].join("\n");
}

export function hasRecentVisibleGroupReply(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}): boolean {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return false;
  }

  return recentVisibleGroupReplies.get(key) === true;
}

export function rememberVisibleGroupReply(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, sentAt: number = Date.now()): void {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return;
  }

  recentVisibleGroupReplies.set(key, true, sentAt);
}

/**
 * When a turn last spoke for itself, keyed the same way.
 *
 * Kept apart from `recentVisibleGroupReplies` on purpose: that map drives a
 * ten-minute suppression of repeated sends, and widening what feeds it would
 * quietly make that rule stricter. This one answers a different question —
 * did core just echo the turn that has only now finished.
 */
// Та же машинерия, что у соседней карты: запись жила до чтения, а читают её
// только если ядро прислало эхо этого хода. Хода без эха — большинство (A6-16).
const lastTurnSends = new ExpiringMap<true>(GROUP_TURN_ECHO_WINDOW_MS);

/**
 * Tool-send delivery state for the dispatch that is currently running.
 *
 * Unlike `lastTurnSends`, this state is not a recency heuristic: the inbound
 * pipeline opens it immediately before core dispatch and consumes it
 * immediately after dispatch. The long TTL is only crash cleanup.
 */
type ActiveGroupTurn = {
  delivered: boolean;
  replyStarted: boolean;
  replyStartPromise?: Promise<void>;
  onVisibleReplyStart?: () => Promise<void> | void;
};

const activeGroupTurns = new ExpiringMap<Map<string, ActiveGroupTurn>>(24 * 60 * 60 * 1000);
let nextGroupTurnOwner = 0;

export function beginGroupTurnDelivery(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, now: number = Date.now()): string | undefined {
  const key = buildVisibleGroupReplyKey(input);
  if (key) {
    const owner = `${++nextGroupTurnOwner}`;
    const owners = activeGroupTurns.get(key, now) ?? new Map<string, ActiveGroupTurn>();
    // A replay that starts after its twin already sent must inherit that
    // observable fact. There may be no second tool call to mark the replay.
    const alreadyDelivered = Array.from(owners.values()).some((state) => state.delivered);
    owners.set(owner, { delivered: alreadyDelivered, replyStarted: alreadyDelivered });
    activeGroupTurns.set(key, owners, now);
    return owner;
  }
  return undefined;
}

export async function finishGroupTurnDelivery(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, owner: string | undefined, now: number = Date.now()): Promise<boolean> {
  const key = buildVisibleGroupReplyKey(input);
  if (!key || !owner) {
    return false;
  }

  const owners = activeGroupTurns.get(key, now);
  const state = owners?.get(owner);
  const delivered = state?.delivered === true;
  // Detach synchronously, before the first await. A concurrent send must not
  // arm an owner whose dispatch has already reached cleanup.
  owners?.delete(owner);
  if (!owners || owners.size === 0) {
    activeGroupTurns.delete(key);
  } else {
    activeGroupTurns.set(key, owners, now);
  }

  // Another overlapping delivery may have started this owner's callback.
  // Do not let the owner tear down its leases while that callback is still
  // acquiring them; the callback promise is installed before start() yields.
  await state?.replyStartPromise?.catch(() => undefined);
  return delivered;
}

/**
 * Attaches channel UX to one live inbound turn without guessing whether the
 * model will speak. The callback is armed before dispatch; a source reply or
 * the message tool triggers it only when visible delivery is about to begin.
 */
export function registerGroupTurnVisibleReplyStart(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, owner: string | undefined, callback: () => Promise<void> | void, now: number = Date.now()): void {
  const key = buildVisibleGroupReplyKey(input);
  if (!key || !owner) return;
  const owners = activeGroupTurns.get(key, now);
  const state = owners?.get(owner);
  if (!owners || !state || state.replyStarted) return;
  state.onVisibleReplyStart = callback;
  activeGroupTurns.set(key, owners, now);
}

/** Starts every owner of this physical update once, before its first send. */
export async function startGroupTurnVisibleReply(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, now: number = Date.now()): Promise<void> {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) return;
  const owners = activeGroupTurns.get(key, now);
  if (!owners) return;

  const starts: Array<Promise<void>> = [];
  for (const state of owners.values()) {
    if (!state.replyStarted) {
      state.replyStarted = true;
      state.replyStartPromise = state.onVisibleReplyStart
        ? Promise.resolve().then(state.onVisibleReplyStart)
        : Promise.resolve();
    }
    if (state.replyStartPromise) starts.push(state.replyStartPromise);
  }
  activeGroupTurns.set(key, owners, now);
  await Promise.allSettled(starts);
}

/** Records that the agent itself put a message in the chat during this turn. */
export function rememberTurnSend(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, sentAt: number = Date.now()): void {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return;
  }

  lastTurnSends.set(key, true, sentAt);
  const owners = activeGroupTurns.get(key, sentAt);
  if (owners) {
    for (const state of owners.values()) {
      state.delivered = true;
    }
    activeGroupTurns.set(key, owners, sentAt);
  }
}

/**
 * True when this turn already put a visible message in this chat moments ago.
 *
 * The case it exists for: the agent answers by calling `send`, then returns
 * text as well, and core delivers that text as a second message. Both are the
 * same answer — on 2026-08-10 every request in a work chat was reported twice,
 * and the reader had to work out that the two messages were one event.
 *
 * Bounded by `GROUP_TURN_ECHO_WINDOW_MS` rather than by the ten-minute TTL:
 * beyond a few seconds the assistant is coming back with something new, and
 * dropping that would lose a real result.
 */
export function hadTurnSendJustNow(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, now: number = Date.now()): boolean {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return false;
  }

  // Окно эха и есть TTL записи, поэтому «свежесть» теперь спрашивается
  // у карты: она же и вычистит просроченное.
  return lastTurnSends.get(key, now) === true;
}

/** Test seam: module state must not leak between suites. */
export function resetVisibleGroupReplies(): void {
  recentVisibleGroupReplies.clear();
  lastTurnSends.clear();
  activeGroupTurns.clear();
  nextGroupTurnOwner = 0;
}
