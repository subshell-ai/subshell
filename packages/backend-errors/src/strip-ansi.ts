/**
 * ANSI/control-character stripping shared by the backend (subshell previews)
 * and the frontend (transcript search): both consume the same raw terminal
 * output, so the two consumers must agree on what counts as escape noise.
 *
 * Strips CSI sequences (`ESC [ ... final-byte`, including DEC private modes
 * like `ESC [ ? 1049 h`), OSC sequences (`ESC ] ...` ended by either BEL or
 * ST = `ESC \`), and carriage returns. Safe for arbitrary terminal output;
 * exported as a pure function so it can be unit-tested.
 */

/**
 * CSI escape sequences (colors, cursor moves, DEC private modes, etc.).
 * Follows the actual ECMA-48 CSI grammar — `ESC [`, then parameter bytes
 * (0x30-0x3F: digits, `;`, `:`, `<`, `=`, `>`, `?`), then intermediate bytes
 * (0x20-0x2F), then a single final byte (0x40-0x7E) — rather than only
 * digits/`;`, so DEC private-mode sequences like `\x1b[?1049h` (alt screen)
 * and `\x1b[?2004h` (bracketed paste) are stripped too, not just plain SGR.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escape sequences
const csiRegex = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
/**
 * OSC strings, terminated either way: BEL (xterm's titles) or ST = `ESC \`
 * (ECMA-48's terminator, what shell-integration output like OSC 133/3008
 * emits). A BEL-only scan ran PAST an ST terminator and swallowed every byte
 * up to the next BEL — measured deleting a whole printed line in spec 22's
 * ssh pane. Lazy matching ends the sequence at the nearest terminator, and
 * one with neither stays untouched: a swallowed tail is worse than a stray
 * escape.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC terminators (BEL and ST)
const oscRegex = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(csiRegex, "").replace(oscRegex, "").replace(/\r/g, "");
}
