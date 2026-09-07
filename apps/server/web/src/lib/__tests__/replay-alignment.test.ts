import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";

/**
 * The CLIENT half of the attach-replay contract (2026-09-04 garble).
 *
 * Every other test in this saga checked what the SERVER sent. This one checks
 * what a real `@xterm/xterm` does with it, which is where the bug actually
 * lived: the replay frame must leave the client's viewport mapped 1:1 onto the
 * pane's rows, because the frame's trailing CUP is the pane's own
 * VIEWPORT-RELATIVE cursor. One row of scroll and that cursor means a
 * different row than tmux meant — and Ink (Claude Code) positions every
 * subsequent frame relative to the cursor, so each one lands on the wrong
 * rows: erases eat transcript lines, previous-frame remnants survive beside
 * the new frame, and once those rows scroll into scrollback nothing repaints
 * them.
 *
 * The frame format is the server's `captureToReplayText` (apps/server/api
 * ws/capture-text.ts); it is reproduced here rather than imported because this
 * asserts the CLIENT's response to the wire format, and the wire is the
 * contract between them. Keep the two in step.
 */

/** How the client writes an attach: reset, then the replay frame verbatim. */
async function writeReplay(frame: string, cols: number, rows: number): Promise<Terminal> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  term.reset();
  term.write(frame);
  // xterm's write queue is async; the empty write's callback flushes it.
  await new Promise<void>((resolve) => term.write("", () => resolve()));
  return term;
}

/**
 * The pane's physical rows, padded to its height — tmux captures every row,
 * trailing blanks included.
 */
function paneRows(rows: string[], height: number): string[] {
  return [...rows, ...Array(Math.max(0, height - rows.length)).fill("")];
}

/**
 * The server's replay frame: rows joined by CRLF with NO trailing terminator
 * (N rows ⇒ N-1 separators), then the pane's cursor as a 1-based CUP. CRLF
 * rather than bare LF is load-bearing on its own — LF keeps the column, which
 * staircases each row right by the previous row's length.
 */
function replayFrame(rows: string[], cursor?: { x: number; y: number }): string {
  return rows.join("\r\n") + (cursor ? CUP(cursor) : "");
}

/** The shipped-and-reported form: the same frame with the final terminator kept. */
function replayFrameWithTrailingTerminator(rows: string[], cursor: { x: number; y: number }): string {
  return `${rows.join("\r\n")}\r\n${CUP(cursor)}`;
}

const CUP = (cursor: { x: number; y: number }) => `\x1b[${cursor.y + 1};${cursor.x + 1}H`;

describe("attach replay leaves the client aligned with the pane", () => {
  const ROWS = 10;
  const COLS = 40;
  // A pane shaped like the reported one: content at the top, the app's cursor
  // parked mid-grid (Claude Code's `❯` input line), blank rows below it.
  const PANE = paneRows(["line1", "line2"], ROWS);
  const PANE_CURSOR = { x: 0, y: 2 };

  it("the fixed frame maps the viewport 1:1 and honours the pane's cursor", async () => {
    const term = await writeReplay(replayFrame(PANE, PANE_CURSOR), COLS, ROWS);
    const buf = term.buffer.active;

    // Nothing scrolled: the buffer is exactly the pane's rows, so viewport
    // row N IS pane row N — the premise that makes the CUP meaningful.
    expect(buf.baseY).toBe(0);
    expect(buf.length).toBe(ROWS);
    // The cursor sits where tmux said it did, and the rows around it match.
    expect({ x: buf.cursorX, y: buf.cursorY }).toEqual(PANE_CURSOR);
    expect(buf.getLine(0)?.translateToString(true)).toBe("line1");
    expect(buf.getLine(1)?.translateToString(true)).toBe("line2");
    expect(buf.getLine(PANE_CURSOR.y)?.translateToString(true)).toBe("");
  });

  it("an Ink-style relative repaint lands on the right rows after that frame", async () => {
    // What the app does next: from its cursor, walk up over the frame it
    // last drew and rewrite it. With the cursor correct this overwrites
    // exactly line1/line2; with the cursor one row off it would eat a
    // transcript row and leave a remnant of the old frame behind.
    const term = await writeReplay(replayFrame(PANE, PANE_CURSOR), COLS, ROWS);
    term.write("\x1b[2A\x1b[2Kfresh1\r\n\x1b[2Kfresh2");
    await new Promise<void>((resolve) => term.write("", () => resolve()));

    const buf = term.buffer.active;
    expect(buf.getLine(0)?.translateToString(true)).toBe("fresh1");
    expect(buf.getLine(1)?.translateToString(true)).toBe("fresh2");
    expect(buf.baseY).toBe(0); // still no scroll: nothing was pushed away
  });

  it("REGRESSION: keeping the capture's trailing terminator scrolls the viewport out of step", async () => {
    // The shipped-and-reported form. tmux terminates the LAST row too, so the
    // cursor goes one row past the grid, which at the bottom margin scrolls —
    // and every viewport-relative coordinate is then off by one.
    const term = await writeReplay(replayFrameWithTrailingTerminator(PANE, PANE_CURSOR), COLS, ROWS);
    const buf = term.buffer.active;

    expect(buf.baseY).toBe(1); // the pane's first row was pushed into scrollback
    expect(buf.length).toBe(ROWS + 1);
    // The CUP asked for pane row 2. It landed on pane row 3 — one row of drift
    // per attach, which is the whole bug.
    expect(buf.cursorY + buf.baseY).toBe(PANE_CURSOR.y + 1);
  });
});
