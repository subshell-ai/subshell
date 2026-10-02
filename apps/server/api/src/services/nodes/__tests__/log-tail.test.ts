import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cursorLinesFromWindow,
  LOG_MAX_WINDOW_BYTES,
  LOG_WINDOW_DEFAULT_BYTES,
  readLogCursor,
  readLogTailFrom,
} from "../log-tail.js";

/**
 * Pure line math + composition behind the byte cursor (spec 2026-10-01 §3).
 * The route suite drives the whole stack; this file pins the rules at their
 * source, where they cannot be papered over by a friendly file layout:
 * raw-byte offsets, line-aligned resume, the liveness rule, and tail-mode
 * parity with the untouched {@link readLogTailFrom}.
 */

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

describe("cursorLinesFromWindow", () => {
  it("consumes only newline-terminated lines and resumes at the boundary", () => {
    const r = cursorLinesFromWindow(enc("alpha\nbravo\ncharlie\n"), 0, 20);
    expect(r).toEqual({ lines: ["alpha", "bravo", "charlie"], truncated: false, nextByte: 20 });
  });

  it("leaves a window-edge partial line unconsumed: no split, no loss", () => {
    const r = cursorLinesFromWindow(enc("alpha\nbravo"), 0, 11);
    expect(r).toEqual({ lines: ["alpha"], truncated: true, nextByte: 6 });
  });

  it("offsets count RAW bytes: a window starting at 6 reads the second line", () => {
    const r = cursorLinesFromWindow(enc("bravo\ncharlie\n"), 6, 14);
    expect(r).toEqual({ lines: ["bravo", "charlie"], truncated: false, nextByte: 20 });
  });

  it("liveness: a window with no newline returns the partial line and ADVANCES", () => {
    const r = cursorLinesFromWindow(enc("A".repeat(10)), 40, 50);
    expect(r).toEqual({ lines: ["A".repeat(10)], truncated: true, nextByte: 50 });
  });

  it("empty bytes answer empty without moving the cursor past EOF", () => {
    expect(cursorLinesFromWindow(new Uint8Array(0), 50, 10)).toEqual({ lines: [], truncated: false, nextByte: 10 });
    expect(cursorLinesFromWindow(new Uint8Array(0), 3, 10)).toEqual({ lines: [], truncated: false, nextByte: 3 });
  });

  it("strips ANSI from lines while counting raw bytes", () => {
    // 14 RAW bytes (5-byte SGR open, "red", 5-byte close, newline) become the
    // 3-character line "red": the cursor counts what the file holds, not what
    // the display shows.
    const r = cursorLinesFromWindow(enc("\u001b[31mred\u001b[39m\n"), 0, 14);
    expect(r.lines).toEqual(["red"]);
    expect(r.nextByte).toBe(14);
  });

  it("keeps an empty line as an empty string (the pane printed a blank line)", () => {
    const r = cursorLinesFromWindow(enc("\n"), 0, 1);
    expect(r).toEqual({ lines: [""], truncated: false, nextByte: 1 });
  });

  it("counts on bytes, not decoded text: a straddled multibyte char degrades visibly but advances by BYTE count (documented, single-line > window only)", () => {
    // "aé" is 3 raw bytes; a window that ends inside the é yields a replacement
    // glyph and consumes exactly the bytes it was given. A line longer than any
    // window with multibyte content is the ONLY way to hit this.
    const r = cursorLinesFromWindow(new Uint8Array([0x61, 0xc3]), 0, 3);
    expect(r).toEqual({ lines: ["a\uFFFD"], truncated: true, nextByte: 2 });
  });
});

describe("readLogCursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-tail-test-"));

  function fileReader(content: string): {
    read: (f: number, m: number) => Promise<{ bytes: Uint8Array; next: number; size: number }>;
    calls: Array<{ from: number; max: number }>;
  } {
    const bytes = Buffer.from(content, "utf8");
    const calls: Array<{ from: number; max: number }> = [];
    return {
      calls,
      read: async (from, max) => {
        calls.push({ from, max });
        const end = Math.min(bytes.length, from + max);
        const slice = from >= bytes.length ? new Uint8Array(0) : new Uint8Array(bytes.subarray(from, end));
        return { bytes: slice, next: from + slice.byteLength, size: bytes.length };
      },
    };
  }

  it("tail mode answers EXACTLY what readLogTailFrom answers, plus nextByte at EOF (parity)", async () => {
    const content = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    const path = join(dir, "parity.log");
    writeFileSync(path, content);
    const legacy = await readLogTailFrom(path);
    const r = fileReader(content);
    const composed = await readLogCursor(r.read, {});
    expect({ lines: composed.lines, truncated: composed.truncated }).toEqual(legacy);
    expect(composed.nextByte).toBe(Buffer.byteLength(content));
    expect(r.calls.length).toBe(2); // size probe + window, the remote tail's exact shape
  });

  it("empty log answers empty in ONE call, cursor 0", async () => {
    const r = fileReader("");
    const res = await readLogCursor(r.read, {});
    expect(res).toEqual({ lines: [], truncated: false, nextByte: 0 });
    expect(r.calls.length).toBe(1); // the probe already knows size 0; no second hop
  });

  it("clamps the window: negative offsets to 0, budgets into [1, LOG_MAX_WINDOW_BYTES], default in between", async () => {
    const r = fileReader("x\n".repeat(100_000));
    await readLogCursor(r.read, { fromByte: -5, maxBytes: 0 });
    expect(r.calls[0]).toEqual({ from: 0, max: 1 }); // cursor mode is ONE call; both bounds clamped
    const r2 = fileReader("x\n");
    await readLogCursor(r2.read, { fromByte: 0, maxBytes: 10_000_000 });
    expect(r2.calls[0].max).toBe(LOG_MAX_WINDOW_BYTES);
    const r3 = fileReader("x\n");
    await readLogCursor(r3.read, { fromByte: 0 });
    expect(r3.calls[0].max).toBe(LOG_WINDOW_DEFAULT_BYTES);
  });

  it("cursor at/after EOF: empty, truncated false, parked (a quiet-pane poll never drifts)", async () => {
    const r = fileReader("data\n");
    expect(await readLogCursor(r.read, { fromByte: 5 })).toEqual({ lines: [], truncated: false, nextByte: 5 });
    expect(await readLogCursor(r.read, { fromByte: 99 })).toEqual({ lines: [], truncated: false, nextByte: 5 });
  });

  it("a cursor dropped mid-line (a hand-typed offset) reads the line's remaining tail, not nothing", async () => {
    const r = fileReader("data\n");
    // fromByte 3 sits inside "data": the only newline-terminated content in
    // the window ends the line, so "a" (the remainder) is returned honestly.
    expect(await readLogCursor(r.read, { fromByte: 3 })).toEqual({ lines: ["a"], truncated: false, nextByte: 5 });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
