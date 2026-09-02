import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@internal/session-protocol";

/** One key-bar button — every button sends raw bytes, like a physical key. */
export interface KeyBarButton {
  /** Glyph printed on the button */
  label: string;
  /**
   * Raw bytes written to the pane. Plain CSI arrows (not SS3): tmux
   * translates them for whatever cursor mode the inner app set — the same
   * encoding a desktop xterm sends (mirrors terminal-key-bar.tsx:9-13).
   */
  bytes: string;
}

/** The main row — ported byte-for-byte from `apps/frontend/src/components/terminal-key-bar.tsx:15-33`. */
export const KEY_BAR_BUTTONS: KeyBarButton[] = [
  { label: "Esc", bytes: "\x1b" },
  { label: "^C", bytes: "\x03" },
  { label: "⇧Tab", bytes: "\x1b[Z" },
  { label: "Tab", bytes: "\t" },
  // CR is what a physical Enter sends (xterm emits "\r"), so form prompts
  // answer identically from the bar or a hardware keyboard.
  { label: "⏎", bytes: "\r" },
  // The touch stand-in for Shift+Enter: ESC+CR, which the harnesses read as
  // "insert a newline".
  { label: "⇧⏎", bytes: "\x1b\r" },
  // A plain "/" byte — the pane's program owns the character; subshell intercepts nothing.
  { label: "/", bytes: "/" },
  { label: "←", bytes: "\x1b[D" },
  { label: "↑", bytes: "\x1b[A" },
  { label: "↓", bytes: "\x1b[B" },
  { label: "→", bytes: "\x1b[C" },
];

/** The `⋯` page: Ctrl letters and CSI page keys (spec §Screens key bar). */
export const KEY_BAR_EXTENDED: KeyBarButton[] = [
  { label: "^D", bytes: "\x04" },
  { label: "^L", bytes: "\x0c" },
  { label: "^R", bytes: "\x12" },
  { label: "PgUp", bytes: "\x1b[5~" },
  { label: "PgDn", bytes: "\x1b[6~" },
];

/** Arrows repeat while held (spec: "press-repeat on arrows"). */
export function isRepeatable(label: string): boolean {
  return label === "←" || label === "↑" || label === "↓" || label === "→";
}

/**
 * One `input` frame's payload for a paste: wrapped in bracketed-paste markers
 * when the pane has DECSET 2004 on, so "/"-leading paths are not read as
 * slash commands — the same rule as the web `session-frames.injectText`.
 * @param text - Clipboard text
 * @param bracketed - Whether the remote has bracketed paste enabled
 */
export function wrapPaste(text: string, bracketed: boolean): string {
  if (!text) return "";
  return bracketed ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;
}
