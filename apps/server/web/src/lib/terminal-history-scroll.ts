import type { Terminal } from "@xterm/xterm";

export type HistoryScrollAction = "top" | "bottom" | "page-up" | "page-down";

/** Full-screen programs own their history; the alternate buffer has no local scrollback. */
export function scrollTerminalHistory(term: Terminal, action: HistoryScrollAction, canSendInput: boolean): void {
  if (term.buffer.active.type === "alternate") {
    if (!canSendInput) return;
    // Home and End each have two spellings and the program in the pane decides
    // which one it bound. An app that asked for Application Cursor Keys
    // (DECCKM) reads the SS3 forms, which is what its own keyboard would hand
    // it; the CSI forms can go unanswered. Page Up and Down are CSI either
    // way, so without this the bar reads as half working.
    const appCursor = term.modes.applicationCursorKeysMode;
    const keys: Record<HistoryScrollAction, string> = {
      top: appCursor ? "\x1bOH" : "\x1b[H",
      bottom: appCursor ? "\x1bOF" : "\x1b[F",
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
