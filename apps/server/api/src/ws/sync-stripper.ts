/**
 * DEC private mode 2026 (synchronized output) marker removal for the
 * terminal relay — the single home for the markers and both stripping modes.
 *
 * Some TUIs (claude-code's ink renderer among them) open a synchronized
 * update and leave it open until their next redraw — which on an idle prompt
 * can be a full second later. xterm 6 honors the mode by withholding all
 * painting until the closing marker or its 1000ms safety timeout, so every
 * keystroke echo visually lands one second late. Tearing without the mode is
 * what every pre-2026 terminal has lived with for decades; a guaranteed
 * 1s paint gate is the worse trade.
 *
 * Measured on a claude-code subshell: keystroke→paint ~1010 ms with the
 * markers, 1–30 ms without them. Every byte the attach endpoints send
 * outbound (replay, live tail, pane-poll fallback) must pass through here —
 * do not reintroduce the markers anywhere on that path.
 */

// The markers are built at runtime so no control-character literal appears
// in source (biome's noControlCharactersInRegex); plain split/join also beats
// a regex here.
const ESC = String.fromCharCode(27);
const SYNC_BEGIN = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
/** Longest run of leading marker bytes that is not yet a full marker. */
const MAX_PARTIAL_LEN = SYNC_BEGIN.length - 1; // both markers are 9 chars

/**
 * Stateless removal of complete begin/end markers from one whole string.
 * Correct whenever no marker straddles a chunk boundary; the attach-time
 * `replay` frame uses this (a single `capture-pane` payload, no boundary).
 */
export function stripSyncMarkers(s: string): string {
  if (!s.includes("2026")) return s;
  return s.split(SYNC_BEGIN).join("").split(SYNC_END).join("");
}

/**
 * Per-connection stateful stripper for the live byte streams.
 *
 * The tail slices the log at arbitrary byte offsets, so a 9-byte marker can
 * be split across two chunks — the stateless strip then misses both halves,
 * xterm completes the sequence across its own writes and opens a synchronized
 * update, and painting gates for up to 1000 ms. This holds back the longest
 * trailing run that is a strict prefix of either marker (≤ 8 bytes) and
 * re-tests it once the next chunk arrives.
 *
 * Holding is invisible to the user: those bytes are an INCOMPLETE escape
 * sequence, which xterm buffers internally across `write()` calls anyway —
 * the hold just moves the same buffering one hop upstream. A false-positive
 * hold (e.g. `ESC [ ? 2` from a later `ESC [ ? 25l` cursor-hide) re-emits
 * intact as soon as the following bytes arrive.
 */
export class SyncStreamStripper {
  #pending = "";

  /** Strips `chunk` (with any carried-over partial prefix) and returns the safe prefix to emit now. */
  push(chunk: string): string {
    if (!chunk) return "";
    const merged = this.#pending + chunk;
    this.#pending = "";
    const stripped = stripSyncMarkers(merged);
    const hold = partialMarkerSuffixLen(stripped);
    if (hold > 0) {
      this.#pending = stripped.slice(stripped.length - hold);
      return stripped.slice(0, stripped.length - hold);
    }
    return stripped;
  }

  /**
   * The held tail, if any — the stream is over (client detached). The bytes
   * belonged to an incomplete sequence either way; a reconnect replays the
   * pane, so callers may drop the result. Provided for tests and honesty.
   */
  flush(): string {
    const held = this.#pending;
    this.#pending = "";
    return held;
  }
}

/** Length of the longest suffix of `s` that is a strict prefix of either marker (0 when none). */
function partialMarkerSuffixLen(s: string): number {
  const max = Math.min(s.length, MAX_PARTIAL_LEN);
  for (let k = max; k > 0; k--) {
    const suffix = s.slice(s.length - k);
    if (SYNC_BEGIN.startsWith(suffix) || SYNC_END.startsWith(suffix)) return k;
  }
  return 0;
}
