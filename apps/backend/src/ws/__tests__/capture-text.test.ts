import { describe, expect, it } from "bun:test";
import { captureToTerminalText } from "@/ws/capture-text.js";

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
