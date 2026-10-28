import type { Terminal } from "@xterm/xterm";

export type HistoryScrollAction = "top" | "bottom" | "page-up" | "page-down";

/** Full-screen programs own their history; the alternate buffer has no local scrollback. */
export function scrollTerminalHistory(term: Terminal, action: HistoryScrollAction, canSendInput: boolean): void {
  if (term.buffer.active.type === "alternate") {
    if (!canSendInput) return;
    const keys: Record<HistoryScrollAction, string> = {
      top: "\x1b[H",
      bottom: "\x1b[F",
      "page-up": "\x1b[5~",
      "page-down": "\x1b[6~",
    };
    // Use xterm's regular input path so connection and permission guards still apply.
    term.input(keys[action], true);
    return;
  }
  if (action === "top") term.scrollToTop();
  else if (action === "bottom") term.scrollToBottom();
  else term.scrollPages(action === "page-up" ? -1 : 1);
}
