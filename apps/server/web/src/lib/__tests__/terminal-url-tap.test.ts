import { describe, expect, it } from "bun:test";
import { cellAtPoint, urlTokenAt } from "@/lib/terminal-url-tap";

/** The width every fixture below is written at. A line of exactly this many
 * characters is a line that wrapped at the edge (the trim is the tell). */
const COLS = 40;

function tap(line: string, col: number, opts: { above?: string; below?: string; cols?: number } = {}) {
  return urlTokenAt({ line, col, cols: opts.cols ?? COLS, above: opts.above, below: opts.below });
}

describe("urlTokenAt (the tapped token, wrapped-URL aware)", () => {
  it("opens a plain URL token, tapping anywhere in it", () => {
    // "See https://example.com/docs for more." → the URL spans cols 4..27.
    expect(tap("See https://example.com/docs for more.", 1)).toBeNull(); // "See" is not a URL
    expect(tap("See https://example.com/docs for more.", 4)).toBe("https://example.com/docs");
    expect(tap("See https://example.com/docs for more.", 20)).toBe("https://example.com/docs");
    expect(tap("See https://example.com/docs for more.", 28)).toBeNull(); // the space
    expect(tap("See https://example.com/docs for more.", 30)).toBeNull(); // "for"
  });

  it("an empty line or a blank column opens nothing", () => {
    expect(tap("", 0)).toBeNull();
    expect(tap("   ", 1)).toBeNull();
    expect(tap("word", 4)).toBeNull(); // the col sits past the text (the blank buffer cell)
  });

  it("a non-URL token never opens, whatever scheme-shaped thing it resembles", () => {
    expect(tap("ftp://files.example.com/pub", 0)).toBeNull();
    expect(tap("example.com/plain-host", 0)).toBeNull();
    expect(tap("javascript:alert(1)", 0)).toBeNull(); // the opener would refuse it; the extractor never even offers
    expect(tap("not-a-url", 0)).toBeNull();
  });

  it("strips the punctuation prose trails a URL with", () => {
    expect(tap("See https://example.com/path).", 4)).toBe("https://example.com/path");
    expect(tap("See https://example.com/path,", 4)).toBe("https://example.com/path");
    expect(tap('open "https://example.com/path"', 6)).toBeNull(); // LEADING punctuation is not stripped
  });

  it("a URL at the very end of a SHORT line is complete, not continued", () => {
    // "https://a.com" ends before the wrap edge; the unrelated word starting
    // the next line is a new token, and joining it would open a wrong URL.
    expect(tap("done https://a.com", 5, { below: "next unrelated words" })).toBe("https://a.com");
  });

  it("joins a URL that WRAPS: tapping the head on the full-width line", () => {
    const head = "visit https://example.com/very/long/path"; // exactly 40 → wrapped
    expect(head.length).toBe(COLS);
    const tail = "/page-2 done here";
    expect(tap(head, 20, { below: tail })).toBe("https://example.com/very/long/path/page-2");
  });

  it("joins a URL that WRAPS: tapping the tail on the line below", () => {
    const head = "visit https://example.com/very/long/path"; // full width
    const tail = "/page-2 done here";
    expect(tap(tail, 0, { above: head })).toBe("https://example.com/very/long/path/page-2");
  });

  it("a wrapped tail that trails punctuation still opens clean", () => {
    const wide = "https://ex.io/a/really/deep/path/to/fidd"; // 40 exactly → wrapped
    expect(wide.length).toBe(COLS);
    expect(tap(wide, 2, { below: "le. end of message" })).toBe("https://ex.io/a/really/deep/path/to/fiddle");
  });

  it("a TAIL tapped after a line that did NOT wrap is not joined", () => {
    // The line above ends short of the edge — its URL ended there, honestly.
    expect(tap("orphan-tail", 0, { above: "x https://a.com" })).toBeNull();
  });

  it("a line with tabs splits tokens at the tab", () => {
    const line = "a\thttps://tabbed.dev/x\tb"; // tokens: "a" at 0, the URL at 2..21, "b" at 23
    expect(tap(line, 0)).toBeNull();
    expect(tap(line, 5)).toBe("https://tabbed.dev/x");
    expect(tap(line, 23)).toBeNull();
  });

  it("a bare scheme prefix is not a URL (http:// and https:// need a slash)", () => {
    expect(tap("https:/one-slash", 0)).toBeNull();
  });

  it("uppercase scheme counts (URL schemes are case-insensitive)", () => {
    expect(tap("HTTP://EXAMPLE.COM/x", 0)).toBe("HTTP://EXAMPLE.COM/x");
  });
});

describe("cellAtPoint (tap pixels → grid cell)", () => {
  const grid = { x: 0, y: 0, rect: { left: 100, top: 50 }, cellWidth: 8, cellHeight: 16, cols: 80, rows: 24 };

  it("maps a point to its cell", () => {
    expect(cellAtPoint({ ...grid, x: 100, y: 50 })).toEqual({ col: 0, row: 0 });
    expect(cellAtPoint({ ...grid, x: 107, y: 65 })).toEqual({ col: 0, row: 0 });
    expect(cellAtPoint({ ...grid, x: 140, y: 130 })).toEqual({ col: 5, row: 5 });
  });

  it("refuses points outside the grid (padding, margins, the scrollbar)", () => {
    expect(cellAtPoint({ ...grid, x: 99, y: 60 })).toBeNull();
    expect(cellAtPoint({ ...grid, x: 740, y: 60 })).toBeNull(); // col === cols
    expect(cellAtPoint({ ...grid, x: 101, y: 49 })).toBeNull();
    expect(cellAtPoint({ ...grid, x: 101, y: 434 })).toBeNull(); // row === rows
  });

  it("refuses a zero/negative cell (metrics not settled — never guess)", () => {
    expect(cellAtPoint({ ...grid, cellWidth: 0 })).toBeNull();
    expect(cellAtPoint({ ...grid, cellHeight: 0 })).toBeNull();
  });
});
