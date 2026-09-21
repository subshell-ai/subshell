/**
 * The per-subshell input queue (spec 2026-09-21 Wave A, with the operator's
 * Batching addendum): at-least-once input, chunked to a frame cap, coalesced
 * under backpressure, with the server's dedupe window absorbing the retries.
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
 *
 * Batching, in the two shapes the operator asked for:
 *
 * - CHUNK: every queued entry is at most {@link CHUNK_MAX_BYTES} of UTF-8
 *   (32 KiB, far under the node's 1 MiB frame cap). A large paste becomes
 *   several queued chunks with sequential ids, sent in order, each acked and
 *   retried independently. A pane gets its bytes in one order either way, so
 *   a split at a character boundary is invisible to the program reading it.
 * - COALESCE: while the queue holds anything (the pipe is behind), a new
 *   enqueue JOINS the tail instead of opening a frame: the tail is filled to
 *   the chunk cap and the remainder spills into further unsent chunks. The
 *   backlog ships the moment the acks drain (nothing sent-but-unacked is
 *   left), on reconnect, or on an explicit resend, always in id order.
 *
 * One rule keeps the retry story sound through all of it: an entry's bytes
 * are FROZEN the moment they are sent. A sent entry's id names exactly those
 * bytes to the server's dedupe window, so appending to it would make the
 * retry re-send text the server has already written and dropped, losing the
 * appended part. Coalescing therefore only ever targets UNSENT data; that is
 * why the coalesced burst waits for the drain rather than joining a frame
 * already on the wire.
 */

/** UTF-8 byte cap per queued frame. The node refuses inbound frames above
 * NODE_MAX_FRAME_BYTES (1 MiB), and the plane's signed command adds a JWS
 * wrapper plus JSON escaping on top of the text, so 32 KiB of text stays
 * comfortably inside every bound on every leg. */
export const CHUNK_MAX_BYTES = 32 * 1024;

/** How many unacked frames the queue will hold. Each is at most
 * {@link CHUNK_MAX_BYTES}, so the worst case is bounded; dropping the OLDEST
 * keeps the newest keystrokes, which are the ones the user means. Dropped
 * ids are simply gone, the same way every pre-queue input was. */
const MAX_PENDING = 1024;

/** RTT samples kept for the diagnostics HUD (Wave C). A small ring: older
 * samples age out so the p50 tracks the connection's recent behavior. */
const RTT_SAMPLES = 32;

/**
 * A sender hands one input to the wire and reports whether it actually left:
 * false means the attach was not live (socket down, server attach not
 * finished), which is the queue's signal to HOLD the bytes as unsent backlog
 * instead of pretending a frame is in flight.
 * `id` is undefined only on the unengaged fallback path (old server, or
 * before the first `viewers` frame).
 */
export type InputSender = (data: string, id: number | undefined) => boolean;

/** One queued frame: sent and awaiting its ack, or unsent backlog. */
interface PendingInput {
  /** The id on the wire; the ack returns it. */
  id: number;
  /** The bytes. Frozen once {@link PendingInput.sent}; coalescing never touches sent bytes. */
  data: string;
  /** UTF-8 byte length of {@link data}, cached so coalescing does not re-encode the tail on every append. */
  dataBytes: number;
  /** When this input was ENQUEUED; the badge's stall age counts from here, even before any send. */
  queuedAt: number;
  /** When this frame was LAST put on the wire (the RTT clock); 0 while unsent. */
  sentAt: number;
  /** False until the frame actually left; the sender reports delivery. */
  sent: boolean;
}

/** Live queue facts for the badge and the Wave C HUD. */
export interface InputQueueStats {
  /** Pending FRAMES (chunks): sent-unacked plus unsent backlog. */
  depth: number;
  /** Age of the oldest unretired input, or null when the queue is empty. */
  unackedOldestMs: number | null;
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

/** Unacked age past which the queue reads as stalled. Shared by the badge's
 * render and its tests, so the threshold is one number, not two. */
export const QUEUE_STALL_MS = 2000;

/**
 * The badge's read of the live stats: shown only while the queue holds
 * anything, amber once the oldest unacked input has waited past the stall
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

export interface InputQueue {
  /** Turns on id tracking: call when the server's `viewers` frame carries
   * `inputAcks`. Never un-engages except through {@link disengage}. */
  engage(): void;
  /** True once the server advertised acks for this attach session. */
  readonly engaged: boolean;
  /**
   * Hands input to the wire. Engaged, the input is chunked and tracked for
   * retry, sent immediately when the queue is empty and coalesced into the
   * unsent tail while the pipe is behind; not engaged, it is sent bare (no
   * id), exactly as every pre-queue client did.
   */
  enqueue(text: string): void;
  /** Retires an acked id: records its RTT and drops it from the queue. Also
   * the moment the coalesced backlog ships, when this was the last ack. */
  ack(id: number): void;
  /** Sends every pending frame in id order, ids unchanged. Called on every
   * socket's first server frame (a no-op on the queue's first, empty attach). */
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** UTF-8 byte length of a string (the wire cost of the data field). */
function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * Splits `text` so the head is at most `maxBytes` UTF-8 bytes, cutting only
 * at a character boundary: the boundary walk backs off UTF-8 continuation
 * bytes, so a multi-byte character (an emoji included) is never split.
 * @param text - The text to split
 * @param maxBytes - The head's byte budget
 * @returns The head and the remainder
 */
function splitAtByteLimit(text: string, maxBytes: number): [string, string] {
  const bytes = textEncoder.encode(text);
  if (bytes.length <= maxBytes) return [text, ""];
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return [textDecoder.decode(bytes.subarray(0, end)), textDecoder.decode(bytes.subarray(end))];
}

/**
 * Splits text into chunks of at most {@link maxBytes} bytes each, in order.
 * @param text - The text to chunk
 * @param maxBytes - The per-chunk byte cap
 * @returns The chunks (one for text that already fits)
 */
function chunkToLimit(text: string, maxBytes: number): string[] {
  if (byteLength(text) <= maxBytes) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest) {
    const [piece, more] = splitAtByteLimit(rest, maxBytes);
    chunks.push(piece);
    rest = more;
  }
  return chunks;
}

/**
 * Builds the queue for one attach session.
 * @param sender - Puts one input on the wire and reports delivery; reads the
 *   live socket at call time, so the same sender serves every reconnect.
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

  /** Records one frame as on the wire. */
  const markSent = (entry: PendingInput): void => {
    entry.sent = true;
    entry.sentAt = now();
    sender(entry.data, entry.id);
  };

  /** Enters a frame into the queue, evicting the OLDEST beyond the cap (Map
   * iteration is insertion order, and ids are monotonic, so that is also the
   * oldest typed). Eviction is the one place input is dropped; see
   * MAX_PENDING for why it is a frame count. */
  const track = (entry: PendingInput): void => {
    pending.set(entry.id, entry);
    if (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined && oldest !== entry.id) pending.delete(oldest);
    }
  };

  /**
   * Ships the unsent backlog once nothing sent-but-unacked remains: the
   * coalesced burst leaves as frames the moment the pipe is clear, in id
   * order. While a sent frame is still unacked, the backlog waits, because
   * sending ahead of it would be the head-of-line-free but frame-per-
   * keystroke behavior the batching addendum replaces.
   */
  const flushBacklog = (): void => {
    for (const entry of pending.values()) {
      if (entry.sent) return;
    }
    const backlog = [...pending.values()].sort((a, b) => a.id - b.id);
    for (const entry of backlog) markSent(entry);
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
      if (!engaged) {
        sender(text, undefined);
        return;
      }
      const chunks = chunkToLimit(text, CHUNK_MAX_BYTES);
      if (pending.size === 0) {
        // Fast path: the pipe is clear, so every chunk leaves now, in order.
        for (const data of chunks) {
          const id = ++nextId;
          const delivered = sender(data, id);
          track({
            id,
            data,
            dataBytes: byteLength(data),
            queuedAt: now(),
            sentAt: delivered ? now() : 0,
            sent: delivered,
          });
        }
        notify();
        return;
      }
      // Backpressure: join the tail instead of opening a frame per keystroke.
      // Only UNSENT bytes are appendable (see the frozen-frames rule), so a
      // tail already on the wire is left alone and the burst opens new frames.
      // Map iteration is insertion order and ids are monotonic, so the last
      // value is the tail.
      let tail: PendingInput | undefined;
      for (const entry of pending.values()) tail = entry;
      let rest = text;
      if (tail && !tail.sent) {
        const [fill, more] = splitAtByteLimit(text, CHUNK_MAX_BYTES - tail.dataBytes);
        if (fill) {
          tail.data += fill;
          tail.dataBytes += byteLength(fill);
        }
        rest = more;
      }
      while (rest) {
        const [data, more] = splitAtByteLimit(rest, CHUNK_MAX_BYTES);
        const id = ++nextId;
        track({ id, data, dataBytes: byteLength(data), queuedAt: now(), sentAt: 0, sent: false });
        rest = more;
      }
      notify();
    },
    ack: (id) => {
      const entry = pending.get(id);
      if (!entry) return;
      // RTT only means something against the LAST send (a resend restarts the
      // clock); measuring from the first would fold retry time into echo
      // time and the HUD would read the retry, not the link. An unsent entry
      // has no RTT to record.
      if (entry.sent) {
        rtts.push(now() - entry.sentAt);
        if (rtts.length > RTT_SAMPLES) rtts.shift();
      }
      pending.delete(id);
      flushBacklog();
      notify();
    },
    resendPending: () => {
      if (pending.size === 0) return;
      // Id order, always: the pane must receive what the user typed in the
      // order they typed it, and the server's dedupe window consults per id.
      // Unsent backlog ships here too: a reconnect is a flush point.
      const entries = [...pending.values()].sort((a, b) => a.id - b.id);
      for (const entry of entries) markSent(entry);
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
        if (oldest === null || entry.queuedAt < oldest) oldest = entry.queuedAt;
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
