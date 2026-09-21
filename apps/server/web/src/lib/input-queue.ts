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
 * server advertised acks.
 *
 * Before the server has ANSWERED (its first `viewers` frame, which arrives
 * after the replay), the queue does not fire into an attach that cannot take
 * bytes: the sender refuses while the attach is not live, and the pre-Wave A
 * fallback dropped them there. Instead typed bytes wait in a PRE-ENGAGE
 * BUFFER (see {@link createInputQueue}); when the answer engages tracking
 * they ship as the first tracked chunks, and on a server that never will
 * they ship bare, exactly as every pre-queue client sent them.
 *
 * Ids are per-session monotonic from 1 and carry across reconnects; a fresh
 * page load starts a fresh namespace, which is safe because the server keys
 * its dedupe window by (subshell, session).
 *
 * Batching, in the two shapes the operator asked for:
 *
 * - CHUNK: every queued entry serializes to at most {@link CHUNK_MAX_BYTES}
 *   (32 KiB, far under the node's 1 MiB frame guard). A large paste becomes
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

/**
 * Serialized-frame budget per queued entry, in bytes.
 *
 * Measured on the WIRE shape, not on the text: the frame is
 * `JSON.stringify({ type: "input", data, id })`, so JSON escaping (a control
 * character costs 6 bytes as \uXXXX, a quote or backslash 2) is part of the
 * cost, and the node daemon refuses any inbound frame above
 * NODE_MAX_FRAME_BYTES (1 MiB) outright. Every entry's serialized frame is
 * capped here, which is what makes the zombie id impossible: a frame too
 * large for the node is dropped with no result frame, its ack would never
 * come, and the id would be re-sent on every reconnect forever. The budget
 * is enforced at SPLIT time and every enqueue path splits, so no path can
 * create an oversize entry.
 */
export const CHUNK_MAX_BYTES = 32 * 1024;

/**
 * The fixed part of an input frame, measured once against an id of
 * eleven digits (far beyond any real session's 512-frame ceiling). Exported
 * beside {@link CHUNK_MAX_BYTES} because the pre-engage buffer needs the
 * same per-piece budget the queue's own chunker applies.
 */
export const FRAME_OVERHEAD_BYTES = new TextEncoder().encode('{"type":"input","data":"","id":99999999999}').length;

/** How many unacked frames the queue will hold. Matched to the server's
 * dedupe window (512, ws/input-window.ts): a reconnect resend can only carry
 * ids the window still holds, so a landed write is always recognized and
 * never re-written. Each frame is at most {@link CHUNK_MAX_BYTES}, so the
 * memory bound is fixed; dropping the OLDEST keeps the newest keystrokes,
 * which are the ones the user means. Dropped ids are simply gone, the same
 * way every pre-queue input was. */
const MAX_PENDING = 512;

/** RTT samples kept for the diagnostics HUD (Wave C). A small ring: older
 * samples age out so the p50 tracks the connection's recent behavior. */
const RTT_SAMPLES = 32;

/**
 * A sender hands one input to the wire and reports whether it actually left:
 * false means the attach was not live (socket down, server attach not
 * finished), which is the queue's signal to HOLD the bytes as unsent backlog
 * instead of pretending a frame is in flight — or, while unengaged, to keep
 * them in the pre-engage buffer rather than drop them.
 * `id` is undefined only on the bare fallback path (an old server, or a
 * pre-engage buffer flushed by a downgrade).
 */
export type InputSender = (data: string, id: number | undefined) => boolean;

/** One queued frame: sent and awaiting its ack, or unsent backlog. */
interface PendingInput {
  /** The id on the wire; the ack returns it. */
  id: number;
  /** The bytes. Frozen once {@link PendingInput.sent}; coalescing never touches sent bytes. */
  data: string;
  /** Serialized frame bytes of {@link data} (the JSON-escaped length), cached so coalescing does not re-scan the tail on every append. */
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
   * `inputAcks`. First ships the pre-engage buffer as tracked chunks (see
   * {@link enqueue}), so its older bytes take the first ids. Never
   * un-engages except through {@link disengage}. */
  engage(): void;
  /** True once the server advertised acks for this attach session. */
  readonly engaged: boolean;
  /**
   * Hands input to the wire. Engaged, the input is chunked and tracked for
   * retry, sent immediately when the queue is empty and coalesced into the
   * unsent tail while the pipe is behind. Not engaged, it is sent bare (no
   * id) when the pipe is live and nothing waits ahead of it — exactly as
   * every pre-queue client did — and buffered pre-engage otherwise, because
   * a bare send into a dead attach is a byte gone forever (see
   * {@link createInputQueue}).
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
   * today's fire-and-forget. First ships the pre-engage buffer BARE, in
   * order — the old server's own answer — unless the attach is still not
   * live, in which case the buffer is dropped: bare bytes have no id to
   * retry, and that is the outcome they already had pre-queue.
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
 * The frame bytes one UTF-16 unit (or surrogate pair) contributes when the
 * data field is JSON-serialized: JSON escapes a quote or backslash to two
 * bytes, the five named control characters to two, every other control
 * character to six (\uXXXX), and leaves everything else as its own UTF-8.
 * @param text - The full text (read for the surrogate pair)
 * @param i - The unit index to measure
 * @returns The unit's width in UTF-16 units and its frame bytes
 */
function unitFrameBytes(text: string, i: number): [units: number, bytes: number] {
  const code = text.charCodeAt(i);
  const high = code >= 0xd800 && code <= 0xdbff;
  const next = high ? text.charCodeAt(i + 1) : 0;
  if (high && next >= 0xdc00 && next <= 0xdfff) return [2, 4]; // one astral character, raw UTF-8
  if (code >= 0xd800 && code <= 0xdfff) return [1, 6]; // a LONE surrogate: JSON.stringify re-escapes it as \udXXX
  if (code < 0x20) {
    if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return [1, 2];
    return [1, 6]; // \uXXXX
  }
  if (code === 0x22 || code === 0x5c) return [1, 2]; // \" or \\
  if (code <= 0x7e) return [1, 1];
  if (code < 0x800) return [1, 2];
  return [1, 3];
}

/**
 * The byte cost of `data` inside a serialized input frame: the JSON-escaped
 * UTF-8 length of the string. This is the number the chunk split budget is
 * written against, so a payload of control characters chunks SMALLER than
 * the same payload of printable text and no entry can serialize past the
 * frame cap.
 * @param data - The text as it would ride the data field
 * @returns Its serialized size in bytes
 */
function escapeFrameBytes(data: string): number {
  let bytes = 0;
  for (let i = 0; i < data.length; ) {
    const [units, size] = unitFrameBytes(data, i);
    bytes += size;
    i += units;
  }
  return bytes;
}

/**
 * Splits `text` so the head costs at most `budget` frame bytes, cutting only
 * at a character boundary (the scan walks whole UTF-16 units, surrogate
 * pairs included), so a multi-byte character is never split.
 * @param text - The text to split
 * @param budget - The head's serialized-byte budget
 * @returns The head and the remainder
 */
function splitAtFrameBudget(text: string, budget: number): [string, string] {
  if (escapeFrameBytes(text) <= budget) return [text, ""];
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const [units, size] = unitFrameBytes(text, end);
    if (bytes + size > budget) break;
    bytes += size;
    end += units;
  }
  return [text.slice(0, end), text.slice(end)];
}

/**
 * Splits text into chunks whose SERIALIZED frames each fit `budget` bytes,
 * in order. Every enqueue path goes through here, which is the belt: no
 * caller can create an entry whose frame the node would refuse.
 * @param text - The text to chunk
 * @param budget - The per-chunk text budget in frame bytes
 * @returns The chunks (one for text that already fits)
 */
function chunkToFrameBudget(text: string, budget: number): string[] {
  if (escapeFrameBytes(text) <= budget) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest) {
    const [piece, more] = splitAtFrameBudget(rest, budget);
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
  /**
   * The PRE-ENGAGE BUFFER: bytes typed before the queue knew how this server
   * answers input, in typing order, held because the sender refused them (a
   * bare send into an attach that is not yet serving frames is a byte gone
   * forever, as this queue's first cut did). No ids: they may yet ship bare on
   * an old server, and an id handed out before the answer would name a frame
   * the dedupe window may never see. It fills only while `!engaged`; the
   * first `viewers` frame — engage or disengage — is the flush point, which
   * is why it is empty in every steady state.
   */
  let preEngage: string[] = [];

  const notify = (): void => {
    for (const cb of [...listeners]) cb();
  };

  /** Puts one frame on the wire, honoring the sender's delivery report: a
   * send that did not leave (socket down mid-flush) leaves the entry as
   * unsent backlog, which the next reconnect's flush ships. Marking it sent
   * anyway would start an RTT clock that never ends and an ack that can
   * never come. */
  const markSent = (entry: PendingInput): void => {
    const delivered = sender(entry.data, entry.id);
    entry.sent = delivered;
    entry.sentAt = delivered ? now() : 0;
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

  /** Appends text to the pre-engage buffer, coalescing into the tail piece
   * and spilling new ones at the per-entry budget — the same arithmetic the
   * tracked coalesce applies, so a flush hands enqueue pieces that already
   * fit one chunk each and the buffer's memory is bounded per piece. */
  const appendPreEngage = (text: string): void => {
    let rest = text;
    const tailIndex = preEngage.length - 1;
    if (tailIndex >= 0) {
      const tail = preEngage[tailIndex];
      const [fill, more] = splitAtFrameBudget(text, CHUNK_MAX_BYTES - FRAME_OVERHEAD_BYTES - escapeFrameBytes(tail));
      if (fill) preEngage[tailIndex] = tail + fill;
      rest = more;
    }
    while (rest) {
      const [data, more] = splitAtFrameBudget(rest, CHUNK_MAX_BYTES - FRAME_OVERHEAD_BYTES);
      preEngage.push(data);
      rest = more;
    }
    // Capped like the queue is: past MAX_PENDING pieces the OLDEST bytes go,
    // keeping the newest keystrokes (the ones the user means), the same way
    // evicted pending frames go. The dropped bytes are the pre-queue status
    // quo, not a new loss.
    if (preEngage.length > MAX_PENDING) preEngage.splice(0, preEngage.length - MAX_PENDING);
  };

  /**
   * Ships the pre-engage buffer in order. Tracked (the server advertised
   * acks), each piece re-enters through enqueue and takes fresh ids — the
   * buffered bytes never reached the wire, so no id names text the server
   * may have written. Bare (the old server's answer), each piece is one
   * untracked frame exactly as every pre-queue client sent it; a piece the
   * sender cannot take drops it AND the rest, because bare bytes have no id
   * to retry and that is the outcome they already had pre-queue.
   */
  const flushPreEngage = (tracked: boolean): void => {
    if (preEngage.length === 0) return;
    const pieces = preEngage;
    preEngage = [];
    for (const piece of pieces) {
      if (tracked) enqueue(piece);
      else if (!sender(piece, undefined)) break;
    }
  };

  /**
   * Hands input to the wire (see the interface doc for the shape). Defined as
   * a local so the engage-time flush can route the buffer through this same
   * path — buffered bytes are OLDER than anything typed from here on, and
   * flushing them first is what preserves the user's arrival order.
   */
  const enqueue = (text: string): void => {
    if (!text) return;
    if (!engaged) {
      // Bare only while the pipe is live and nothing waits ahead of it;
      // otherwise the bytes join the pre-engage buffer (which is what keeps
      // order: once one byte is waiting, every later byte queues behind it
      // until the flush that ships the waiters).
      if (preEngage.length === 0 && sender(text, undefined)) return;
      appendPreEngage(text);
      return;
    }
    // The per-entry budget subtracts the frame's fixed part, so the
    // SERIALIZED frame of every chunk is at most CHUNK_MAX_BYTES.
    const chunks = chunkToFrameBudget(text, CHUNK_MAX_BYTES - FRAME_OVERHEAD_BYTES);
    if (pending.size === 0) {
      // Fast path: the pipe is clear, so every chunk leaves now, in order.
      for (const data of chunks) {
        const id = ++nextId;
        const delivered = sender(data, id);
        track({
          id,
          data,
          dataBytes: escapeFrameBytes(data),
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
      const [fill, more] = splitAtFrameBudget(text, CHUNK_MAX_BYTES - FRAME_OVERHEAD_BYTES - tail.dataBytes);
      if (fill) {
        tail.data += fill;
        tail.dataBytes += escapeFrameBytes(fill);
      }
      rest = more;
    }
    while (rest) {
      const [data, more] = splitAtFrameBudget(rest, CHUNK_MAX_BYTES - FRAME_OVERHEAD_BYTES);
      const id = ++nextId;
      track({ id, data, dataBytes: escapeFrameBytes(data), queuedAt: now(), sentAt: 0, sent: false });
      rest = more;
    }
    notify();
  };

  return {
    engage: () => {
      if (engaged) return;
      engaged = true;
      // The buffer ships FIRST, through the ordinary path: its pieces take
      // the first ids, and anything enqueued after carries a higher id, so
      // the pane reads the typing order either way.
      flushPreEngage(true);
      notify();
    },
    get engaged() {
      return engaged;
    },
    enqueue,
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
      if (!engaged && pending.size === 0 && preEngage.length === 0) return;
      engaged = false;
      // The buffered bytes ship bare FIRST — the old server's own answer,
      // and chronologically they are the oldest bytes the queue holds. When
      // the attach still cannot take them they are dropped by the flush (see
      // flushPreEngage): untracked bytes have no reconnect rescue.
      flushPreEngage(false);
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
