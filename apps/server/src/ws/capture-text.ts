import { stripSyncMarkers } from "@/ws/sync-stripper.js";

/**
 * The one boundary that turns a `capture-pane` payload into bytes safe to
 * write into a browser terminal. Every capture-derived frame — the attach
 * `replay` and the pane-poll fallback's deltas — must pass through here.
 *
 * Two corrections, both mandatory:
 *
 * 1. **CRLF.** `tmux capture-pane -p` separates rows with a BARE LF and emits
 *    no carriage returns at all (verified: zero CR bytes in a capture). In a
 *    terminal, LF moves the cursor DOWN and leaves the column where it was —
 *    so writing that text into xterm starts each row wherever the previous row
 *    happened to end, modulo the width. For a row of length L in a terminal of
 *    width W that is a drift of `L mod W` per line: rows 72 chars wide in a
 *    75-column terminal march left by exactly 3 columns each, which is the
 *    diagonal staircase of half-tables users reported in SCROLLBACK
 *    (2026-09-02). The visible grid looked fine because the app's live diffs
 *    repaint it with absolute cursor positioning — but nothing ever rewrites
 *    scrollback, so the staircase froze there permanently.
 * 2. **DEC 2026 markers** ({@link stripSyncMarkers}) — the 1 s paint gate.
 *
 * NOT for the live tail. Those bytes are the pane's OWN output, replayed from
 * the pipe-pane log with the app's own control sequences; a bare LF there is
 * what the app deliberately emitted, and rewriting it would corrupt the very
 * cursor arithmetic the app is relying on. Capture text is line-oriented
 * *rendered rows* and is the only thing that needs re-terminating.
 *
 * @param capture - raw `capture-pane` output (grid, optionally + history rows)
 * @returns the same rows, marker-free and CRLF-terminated
 */
export function captureToTerminalText(capture: string): string {
  // `\r?\n` rather than `\n`: idempotent if tmux ever emits CRLF itself, so a
  // future tmux cannot turn this into `\r\r\n`.
  return stripSyncMarkers(capture).replace(/\r?\n/g, "\r\n");
}
