/**
 * The per-subshell input queue (spec 2026-09-21 Wave A): at-least-once input
 * with the server's dedupe window absorbing the retries.
 *
 * While the socket is alive, TCP ordering means an unacked frame is "not
 * yet", never "lost", so there is no timer and no mid-connection resend.
 * Retry lives entirely on RECONNECT: every unacked id is re-sent in order on
 * the fresh socket, and the server's completed-write window drops the ones
 * that already landed. Every keystroke carries its id from the moment the
 * server advertised acks; before that (and on a server that never will), the
 * queue degrades to today's fire-and-forget and holds nothing.
 *
 * Ids are per-session monotonic from 1 and carry across reconnects; a fresh
 * page load starts a fresh namespace, which is safe because the server keys
 * its dedupe window by (subshell, session).
 */

/** How many unacked inputs the queue will hold. A disconnect during fast
 * typing (or mouse-report motion, which rides the same pipe) could otherwise
 * grow without bound; dropping the OLDEST keeps the newest keystrokes, which
 * are the ones the user means. Dropped ids are simply gone, the same way
 * every pre-queue input was. */
const MAX_PENDING = 1024;

/** RTT samples kept for the diagnostics HUD (Wave C). A small ring: older
 * samples age out so the p50 tracks the connection's recent behavior. */
const RTT_SAMPLES = 32;

/** A sender hands one input to the wire. `id` is undefined only on the
 * unengaged fallback path (old server, or before the first `viewers` frame). */
export type InputSender = (data: string, id: number | undefined) => void;

/** One input in flight: sent, awaiting its ack. */
interface PendingInput {
  /** The id on the wire; the ack returns it. */
  id: number;
  /** The bytes. Resends carry them unchanged. */
  data: string;
  /** When this copy was LAST sent, for the RTT measurement. */
  sentAt: number;
}

/** Live queue facts for the badge and the Wave C HUD. */
export interface InputQueueStats {
  /** Inputs sent and unacked, plus nothing else: the queue sends on enqueue. */
  depth: number;
  /** Age of the oldest unacked input, or null when the queue is empty. */
  unackedOldestMs: number | null;
}

/** Unacked age past which the queue reads as stalled. Shared by the badge's
 * render and its tests, so the threshold is one number, not two. */
export const QUEUE_STALL_MS = 2000;

/**
 * The badge's read of the live stats: shown only while the queue holds
 * anything, amber once the oldest unacked id has waited past the stall
 * threshold. Pure so the threshold is testable without timers.
 * @param stats - The queue's live facts
 * @returns Depth to show and whether the badge is amber
 */
export function queueBadgeView(
  stats: InputQueueStats,
  stallMs: number = QUEUE_STALL_MS,
): { depth: number; stalled: boolean } {
  return {
    depth: stats.depth,
    stalled: stats.unackedOldestMs !== null && stats.unackedOldestMs > stallMs,
  };
}

/** Recent round-trip times, for the Wave C HUD's "echo RTT p50 and max". */
export interface RttSamples {
  /** Recent sample count in the ring (bounded at 32). */
  count: number;
  /** Median of the ring, in ms, or null with no samples. */
  p50: number | null;
  /** Worst of the ring, in ms, or null with no samples. */
  max: number | null;
}

export interface InputQueue {
  /** Turns on id tracking: call when the server's `viewers` frame carries
   * `inputAcks`. Never un-engages except through {@link disengage}. */
  engage(): void;
  /** True once the server advertised acks for this attach session. */
  readonly engaged: boolean;
  /**
   * Hands input to the wire. Engaged, the input is tracked for retry; not
   * engaged, it is sent bare (no id), exactly as every pre-queue client did.
   * Works with the socket down: the entry is retained and flushed by the
   * next {@link resendPending}.
   */
  enqueue(text: string): void;
  /** Retires an acked id: records its RTT and drops it from the queue. */
  ack(id: number): void;
  /** Re-sends every unacked input in id order, ids unchanged. Called on
   * every socket open (a no-op on the queue's first, empty attach). */
  resendPending(): void;
  /**
   * Turns tracking off and drops what is pending. For the server that never
   * advertised acks (a downgrade mid-session): those ids can never be acked,
   * and re-sending them would write duplicates, so the honest fallback is
   * today's fire-and-forget with the backlog dropped.
   */
  disengage(): void;
  /** Live facts; read on render (unackedOldestMs is computed at access). */
  readonly stats: InputQueueStats;
  /** Recent RTTs for the diagnostics HUD. */
  readonly rtt: RttSamples;
  /** Subscribes to queue changes (enqueue, ack, resend). Returns the
   * unsubscribe. */
  onStats(cb: () => void): () => void;
}

/**
 * Builds the queue for one attach session.
 * @param sender - Puts one input on the wire; reads the live socket at call
 *   time, so the same sender serves every reconnect.
 * @param now - Epoch-ms clock, injectable for tests
 */
export function createInputQueue(sender: InputSender, now: () => number = Date.now): InputQueue {
  const pending = new Map<number, PendingInput>();
  const rtts: number[] = [];
  const listeners = new Set<() => void>();
  let engaged = false;
  let nextId = 0;

  const notify = (): void => {
    for (const cb of [...listeners]) cb();
  };

  const track = (text: string): void => {
    const id = ++nextId;
    const entry: PendingInput = { id, data: text, sentAt: now() };
    pending.set(id, entry);
    if (pending.size > MAX_PENDING) {
      // Map iteration is insertion order, so the first key is the oldest.
      const oldest = pending.keys().next().value;
      if (oldest !== undefined && oldest !== id) pending.delete(oldest);
    }
    sender(text, id);
    notify();
  };

  return {
    engage: () => {
      if (engaged) return;
      engaged = true;
      notify();
    },
    get engaged() {
      return engaged;
    },
    enqueue: (text) => {
      if (!text) return;
      if (engaged) track(text);
      else sender(text, undefined);
    },
    ack: (id) => {
      const entry = pending.get(id);
      if (!entry) return;
      // RTT only means something against the LAST send (a resend restarts the
      // clock); measuring from the first would fold retry time into echo
      // time and the HUD would read the retry, not the link.
      rtts.push(now() - entry.sentAt);
      if (rtts.length > RTT_SAMPLES) rtts.shift();
      pending.delete(id);
      notify();
    },
    resendPending: () => {
      if (pending.size === 0) return;
      // Id order, always: the pane must receive what the user typed in the
      // order they typed it, and the server's dedupe window consults per id.
      const entries = [...pending.values()].sort((a, b) => a.id - b.id);
      for (const entry of entries) {
        entry.sentAt = now();
        sender(entry.data, entry.id);
      }
      notify();
    },
    disengage: () => {
      if (!engaged && pending.size === 0) return;
      engaged = false;
      pending.clear();
      notify();
    },
    get stats() {
      let oldest: number | null = null;
      for (const entry of pending.values()) {
        if (oldest === null || entry.sentAt < oldest) oldest = entry.sentAt;
      }
      return { depth: pending.size, unackedOldestMs: oldest === null ? null : now() - oldest };
    },
    get rtt() {
      if (rtts.length === 0) return { count: 0, p50: null, max: null };
      const sorted = [...rtts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return {
        count: rtts.length,
        p50: sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2),
        max: sorted[sorted.length - 1],
      };
    },
    onStats: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
