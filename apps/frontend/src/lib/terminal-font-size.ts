/**
 * Per-DEVICE terminal text size (localStorage, not user_meta).
 *
 * Text size is a property of the screen you're holding, not of the account:
 * the same user legitimately wants 13px on a desktop and 17px on a phone.
 * Server-side prefs would fight that (one value, every device), so this one
 * deliberately lives in the browser's own storage — the iOS page-zoom
 * alternative (Safari's aA control) reflows the whole webview and shrinks
 * the usable viewport on home-screen installs; growing the font here costs
 * only columns, which is what a terminal user expects to trade.
 */

/** Size every terminal boots at when this device never chose one. */
export const TERM_FONT_DEFAULT = 13;
/** Usable bounds: below the min the terminal is unreadable; above it a
 * phone viewport has too few columns to be usable. */
export const TERM_FONT_MIN = 11;
export const TERM_FONT_MAX = 22;

/** The event fired on the window when the size changes (live re-apply). */
export const TERM_FONT_EVENT = "subshell:term-font";

const KEY = "subshell.termFontSize";

export function clampTermFont(n: number): number {
  if (!Number.isFinite(n)) return TERM_FONT_DEFAULT;
  return Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, Math.round(n)));
}

/** This device's terminal font size (px), falling back to the default. */
export function terminalFontSize(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return TERM_FONT_DEFAULT;
    return clampTermFont(Number.parseInt(raw, 10));
  } catch {
    // Private-mode throws on access; the default is always safe.
    return TERM_FONT_DEFAULT;
  }
}

/**
 * Persist this device's choice and notify every mounted terminal to
 * re-apply live (xterm takes option changes without recreating the grid).
 */
export function setTerminalFontSize(n: number): number {
  const size = clampTermFont(n);
  try {
    localStorage.setItem(KEY, String(size));
  } catch {
    // Storage refused (private mode/quota): still apply for this session.
  }
  window.dispatchEvent(new CustomEvent<number>(TERM_FONT_EVENT, { detail: size }));
  return size;
}
