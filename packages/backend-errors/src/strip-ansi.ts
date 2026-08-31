/**
 * ANSI/control-character stripping shared by the backend (session previews)
 * and the frontend (transcript search): both consume the same raw terminal
 * output, so the two consumers must agree on what counts as escape noise.
 *
 * Strips CSI sequences (`ESC [ ... final-byte`, including DEC private modes
 * like `ESC [ ? 1049 h`), OSC title sequences (`ESC ] ... BEL`), and carriage
 * returns. Safe for arbitrary terminal output; exported as a pure function so
 * it can be unit-tested.
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
/** OSC title sequences (BEL-terminated). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC title sequences (BEL-terminated)
const oscRegex = /\x1b\][^\x07]*\x07/g;

export function stripAnsi(s: string): string {
  return s.replace(csiRegex, "").replace(oscRegex, "").replace(/\r/g, "");
}
