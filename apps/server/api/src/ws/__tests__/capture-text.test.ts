import { describe, expect, it } from "bun:test";
import { captureToReplayText, captureToTerminalText } from "@/ws/capture-text.js";

/**
 * The capture→browser boundary (2026-09-02 regression).
 *
 * `tmux capture-pane -p` separates rows with a BARE LF and emits no carriage
 * returns at all. LF moves a terminal's cursor down but LEAVES THE COLUMN, so
 * writing that text into xterm starts every row wherever the previous one
 * ended (mod the width) — a diagonal staircase. Reported as "the bottom is
 * fine but scrolling up doesn't render properly": the app's live diffs
 * repaint the visible grid with absolute positioning, but nothing ever
 * rewrites SCROLLBACK, so the staircase froze there.
 */

const ESC = String.fromCharCode(27);

describe("captureToTerminalText", () => {
  it("re-terminates capture rows with CRLF so every row starts at column 0", () => {
    expect(captureToTerminalText("row one\nrow two\nrow three")).toBe("row one\r\nrow two\r\nrow three");
  });

  it("reproduces the reported staircase geometry — and removes it", () => {
    // The user's paste: ~72-char table rows in a ~75-column terminal drifted
    // left by exactly 3 columns per row (72 mod 75 = -3). Any row length in
    // any width is safe once each row is preceded by a carriage return, so
    // assert the invariant that kills the whole class: every line break
    // carries a CR.
    const row = "│ APPROVED (4)       │ #691, #693, #698, #704 — no issues, only     │";
    const capture = [row, row, row].join("\n");
    const out = captureToTerminalText(capture);

    // No bare LF survives anywhere.
    expect(/[^\r]\n/.test(out)).toBe(false);
    expect(out.split("\r\n")).toEqual([row, row, row]);
  });

  it("is idempotent: text that already uses CRLF is not double-terminated", () => {
    // Guards against a future tmux emitting CRLF itself turning into \r\r\n.
    expect(captureToTerminalText("a\r\nb")).toBe("a\r\nb");
    expect(captureToTerminalText(captureToTerminalText("a\nb"))).toBe("a\r\nb");
  });

  it("still strips DEC 2026 sync markers (the 1s paint gate) on the same pass", () => {
    const capture = `${ESC}[?2026hgrid line\nsecond${ESC}[?2026l`;
    expect(captureToTerminalText(capture)).toBe("grid line\r\nsecond");
  });

  it("preserves SGR colour runs and blank rows verbatim", () => {
    // capture-pane -e carries colour; blank grid rows are real content.
    const capture = `${ESC}[31mRED${ESC}[0m\n\n\ntail`;
    expect(captureToTerminalText(capture)).toBe(`${ESC}[31mRED${ESC}[0m\r\n\r\n\r\ntail`);
  });

  it("passes single-row and empty captures through unchanged", () => {
    expect(captureToTerminalText("just the grid")).toBe("just the grid");
    expect(captureToTerminalText("")).toBe("");
  });
});

/**
 * The REPLAY form of that boundary (2026-09-04 garble, root-caused).
 *
 * `capture-pane -p` emits one `\n`-TERMINATED line per physical row — a
 * 10-row pane yields 10 lines and 10 terminators, trailing blank rows
 * included (measured against real tmux). Written into a freshly `reset()`
 * terminal, that last terminator lands the cursor one row past the pane's
 * last row, which at the bottom margin SCROLLS: real xterm 6.0.0 reports
 * `baseY: 1` for the terminated form and `baseY: 0` for the stripped one.
 *
 * One row of scroll desynchronizes the client's viewport from the pane's, so
 * the pane's viewport-relative cursor report stops meaning what it says — and
 * Ink positions every frame RELATIVE to the cursor, so each later frame lands
 * on the wrong rows (erases eat transcript lines, previous-frame remnants
 * survive beside new ones, permanent once scrolled into scrollback).
 */
describe("captureToReplayText", () => {
  it("drops the capture's final terminator: N rows produce N-1 line breaks", () => {
    const pane = "line1\nline2\n\n\n\n\n\n\n\n\n"; // 10 rows, 10 terminators
    expect(pane.split("\n").length - 1).toBe(10);
    const replay = captureToReplayText(pane);
    expect(replay.split("\r\n").length - 1).toBe(9); // one fewer: no scroll
    // Every row is still present and still starts at column 0. (It ends WITH
    // a terminator here only because row 10 is blank — 10 rows still means 9
    // separators, which lands the cursor at the start of row 10 rather than
    // one row past it.)
    expect(replay).toBe("line1\r\nline2\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n");
  });

  it("appends the pane cursor as a 1-based CUP (tmux reports 0-based)", () => {
    expect(captureToReplayText("a\nb\n", { x: 0, y: 2 })).toBe(`a\r\nb${ESC}[3;1H`);
    expect(captureToReplayText("a\nb\n", { x: 7, y: 0 })).toBe(`a\r\nb${ESC}[1;8H`);
  });

  it("omits the CUP when the machine cannot report a cursor (remote agent)", () => {
    const replay = captureToReplayText("a\nb\n");
    expect(replay).toBe("a\r\nb");
    expect(replay).not.toContain(`${ESC}[`);
  });

  it("removes exactly ONE terminator, whichever form tmux produced", () => {
    expect(captureToReplayText("a\nb\n\n")).toBe("a\r\nb\r\n"); // the blank row survives
    expect(captureToReplayText("a\r\nb\r\n")).toBe("a\r\nb"); // hypothetical CRLF tmux
  });

  it("leaves a capture that has no trailing terminator alone", () => {
    expect(captureToReplayText("a\nb")).toBe("a\r\nb");
  });

  it("still strips DEC 2026 markers (the shared normalization)", () => {
    expect(captureToReplayText(`${ESC}[?2026hgrid\n`, { x: 1, y: 1 })).toBe(`grid${ESC}[2;2H`);
  });
});
