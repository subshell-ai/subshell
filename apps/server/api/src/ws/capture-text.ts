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

/**
 * {@link captureToTerminalText} for the ATTACH REPLAY specifically: the same
 * row normalization, minus the capture's final line terminator, plus an
 * absolute cursor position when the pane's cursor is known.
 *
 * **Why the trailing newline must go** (measured, 2026-09-04). `capture-pane
 * -p` emits exactly one `\n`-TERMINATED line per physical row — a 10-row pane
 * yields 10 lines and 10 terminators, trailing blank rows included. The client
 * does `term.reset()` then `write(replay)`, so that last terminator lands the
 * cursor one row BELOW the pane's last row, which at the bottom margin
 * SCROLLS: verified against real xterm 6.0.0, the 10-line form leaves
 * `baseY: 1` and an 11-line buffer, the stripped form `baseY: 0` and 10. One
 * row of scroll shifts the whole viewport, so a viewport-relative cursor
 * report no longer means what it says.
 *
 * **Why that is the garble.** Ink (Claude Code and friends) positions each new
 * frame RELATIVE to the cursor — `\x1b[{n}A`, then rewrite. Land the cursor on
 * the wrong row and every later frame lands on the wrong rows too: erases
 * eat transcript lines, remnants of the previous frame survive beside the new
 * one (the reported `run8in` / `22-zA-Z` superimpositions), and once those
 * rows scroll into scrollback nothing ever repaints them. Before any cursor
 * was restored the delta was the full distance from the app's cursor to the
 * bottom of the grid — ~7 rows in the measured case, which is why "reopen a
 * subshell and it is garbled" reproduced every time, on desktop too.
 *
 * With the terminator dropped, the client's viewport maps 1:1 onto the pane's
 * rows, which is exactly what makes the pane's own (viewport-relative) cursor
 * report meaningful — so the CUP below is only correct in that form. The
 * caller must therefore hand over a capture taken at the client's geometry
 * (the pre-capture resize guarantees it) and a cursor sampled at the same
 * quiet moment as the grid.
 *
 * @param capture - raw `capture-pane` output (grid, optionally + history rows)
 * @param cursor - the pane's cursor, 0-based viewport coordinates; omit when
 *   the machine cannot report it (a remote agent), which leaves the cursor
 *   wherever the last captured row ends
 * @returns replay bytes: normalized rows, no trailing terminator, optional CUP
 */
export function captureToReplayText(capture: string, cursor?: { x: number; y: number }): string {
  // Strip AFTER normalizing, so exactly one line terminator is removed
  // whichever form tmux produced (`\n` today, `\r\n` hypothetically).
  const rows = captureToTerminalText(capture).replace(/\r\n$/, "");
  // CUP is 1-based; tmux's cursor_x/cursor_y are 0-based.
  return cursor ? `${rows}\x1b[${cursor.y + 1};${cursor.x + 1}H` : rows;
}
