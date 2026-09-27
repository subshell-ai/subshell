/**
 * DEC private mode sequence removal for the terminal relay: the single home
 * for the stripped markers and both stripping modes.
 *
 * DEC 2026 (synchronized output): some TUIs (claude-code's ink renderer among
 * them) open a synchronized update and leave it open until their next redraw,
 * which on an idle prompt can be a full second later. xterm 6 honors the mode
 * by withholding all painting until the closing marker or its 1000ms safety
 * timeout, so every keystroke echo visually lands one second late. Tearing
 * without the mode is what every pre-2026 terminal has lived with for decades;
 * a guaranteed 1s paint gate is the worse trade.
 *
 * The alternate-screen modes (1049, 1047, 47): the viewer screen is
 * conceptually a MAIN-buffer transcript (the attach replay is plain
 * capture-pane text), so an app's `?1049h` must never switch the viewer's
 * xterm to the alternate buffer. Measured 2026-09-27: a panel that happened to
 * be open when Claude Code's Ink startup entered the alt screen sat there for
 * its whole life, with no scrollback, no scrollbar and a dead wheel, while
 * viewers attaching later never saw the toggle and scrolled fine (the
 * operator's read: "Linux panes scroll, my always-open mac panels don't").
 * Removing the toggle is safe because an app that enters the alt screen
 * redraws the viewport itself: the `ESC[2J`/`ESC[H` that follow a stripped
 * `?1049h` clear and home the main buffer just as well, and the capture replay
 * already wrote its plain text there.
 *
 * Measured on a claude-code subshell: keystroke→paint ~1010 ms with the
 * markers, 1–30 ms without them. Every byte the attach endpoints send
 * outbound (replay, the attach `history` frame, live tail, pane-poll
 * fallback) must pass through here, and
 * the pane's own log file must NOT: it is the forensic record. Do not
 * reintroduce these sequences anywhere on the outbound path.
 */

// The markers are built at runtime so no control-character literal appears
// in source (biome's noControlCharactersInRegex); plain split/join also beats
// a regex here.
const ESC = String.fromCharCode(27);
const SYNC_BEGIN = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
// Alternate screen, with and without saving the main buffer (the ?1047 pair
// only swaps the buffer, ?47 is the legacy xterm spelling).
const ALT_BEGIN = `${ESC}[?1049h`;
const ALT_END = `${ESC}[?1049l`;
const ALT_NO_SAVE_BEGIN = `${ESC}[?1047h`;
const ALT_NO_SAVE_END = `${ESC}[?1047l`;
const ALT_LEGACY_BEGIN = `${ESC}[?47h`;
const ALT_LEGACY_END = `${ESC}[?47l`;

/**
 * Every sequence removed from the outbound stream. None is a substring of
 * another (the `?` must sit directly against the number, so `?47` never
 * matches inside `?1047`), which is what makes per-marker split/join safe in
 * any order.
 */
const STRIPPED_MODES: readonly string[] = [
  SYNC_BEGIN,
  SYNC_END,
  ALT_BEGIN,
  ALT_END,
  ALT_NO_SAVE_BEGIN,
  ALT_NO_SAVE_END,
  ALT_LEGACY_BEGIN,
  ALT_LEGACY_END,
];

/** Every stripped marker starts with this CSI-private introducer. */
const PRIVATE_INTRODUCER = `${ESC}[?`;

/** Longest run of leading marker bytes that is not yet a full marker. */
const MAX_PARTIAL_LEN = Math.max(...STRIPPED_MODES.map((m) => m.length)) - 1; // the 2026 and 1049/1047 pairs are 8 chars, ?47 is 6

/**
 * Stateless removal of complete markers from one whole string.
 * Correct whenever no marker straddles a chunk boundary; the attach-time
 * `replay` frame uses this (a single `capture-pane` payload, no boundary).
 */
export function stripViewerModes(s: string): string {
  if (!s.includes(PRIVATE_INTRODUCER)) return s;
  for (const marker of STRIPPED_MODES) s = s.split(marker).join("");
  return s;
}

/**
 * Per-connection stateful stripper for the live byte streams.
 *
 * The tail slices the log at arbitrary byte offsets, so a marker can be split
 * across two chunks: the stateless strip then misses both halves, xterm
 * completes the sequence across its own writes, and either painting gates for
 * up to 1000 ms (2026) or the panel lands on the scrollback-less alternate
 * buffer (1049/1047/47). This holds back the longest trailing run that is a
 * strict prefix of any marker (≤ 7 bytes) and re-tests it once the next chunk
 * arrives.
 *
 * Holding is invisible to the user: those bytes are an INCOMPLETE escape
 * sequence, which xterm buffers internally across `write()` calls anyway, so
 * the hold just moves the same buffering one hop upstream. A false-positive
 * hold (e.g. `ESC [ ? 2` from a later `ESC [ ? 25l` cursor-hide) re-emits
 * intact as soon as the following bytes arrive.
 */
export class ModeStreamStripper {
  #pending = "";

  /** Strips `chunk` (with any carried-over partial prefix) and returns the safe prefix to emit now. */
  push(chunk: string): string {
    if (!chunk) return "";
    const merged = this.#pending + chunk;
    this.#pending = "";
    const stripped = stripViewerModes(merged);
    const hold = partialMarkerSuffixLen(stripped);
    if (hold > 0) {
      this.#pending = stripped.slice(stripped.length - hold);
      return stripped.slice(0, stripped.length - hold);
    }
    return stripped;
  }

  /**
   * The held tail, if any: the stream is over (client detached). The bytes
   * belonged to an incomplete sequence either way; a reconnect replays the
   * pane, so callers may drop the result. Provided for tests and honesty.
   */
  flush(): string {
    const held = this.#pending;
    this.#pending = "";
    return held;
  }
}

/** Length of the longest suffix of `s` that is a strict prefix of any stripped marker (0 when none). */
function partialMarkerSuffixLen(s: string): number {
  const max = Math.min(s.length, MAX_PARTIAL_LEN);
  for (let k = max; k > 0; k--) {
    const suffix = s.slice(s.length - k);
    if (STRIPPED_MODES.some((m) => m.startsWith(suffix))) return k;
  }
  return 0;
}
