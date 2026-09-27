import { describe, expect, it } from "bun:test";
import { cellAtPoint, cellToCharIndex, urlTokenAt } from "@/lib/terminal-url-tap";

/** One tap at a CELL column, with the wrap facts the buffer would carry. */
function tap(
  line: string,
  col: number,
  opts: { above?: string; below?: string; wrappedFromAbove?: boolean; wrapsToBelow?: boolean } = {},
) {
  return urlTokenAt({
    line,
    col,
    above: opts.above,
    below: opts.below,
    wrappedFromAbove: opts.wrappedFromAbove ?? false,
    wrapsToBelow: opts.wrapsToBelow ?? false,
  });
}

describe("urlTokenAt (the tapped token, wrap-fact driven)", () => {
  it("opens a plain URL token, tapping anywhere in it", () => {
    // "See https://example.com/docs for more." → the URL spans cells 4..27.
    expect(tap("See https://example.com/docs for more.", 1)).toBeNull(); // "See" is not a URL
    expect(tap("See https://example.com/docs for more.", 4)).toBe("https://example.com/docs");
    expect(tap("See https://example.com/docs for more.", 20)).toBe("https://example.com/docs");
    expect(tap("See https://example.com/docs for more.", 28)).toBeNull(); // the space
    expect(tap("See https://example.com/docs for more.", 30)).toBeNull(); // "for"
  });

  it("an empty line or a blank column opens nothing", () => {
    expect(tap("", 0)).toBeNull();
    expect(tap("   ", 1)).toBeNull();
    expect(tap("word", 4)).toBeNull(); // the cell sits past the text (the blank buffer cell)
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

  it("a URL ending a line that did NOT wrap is complete, not continued", () => {
    // The next line starts an unrelated sentence; the buffer says the row
    // ended on a hard newline (wrapsToBelow false), so no join happens —
    // the exact wrong-open the length heuristic had.
    expect(tap("done https://a.com", 5, { below: "next unrelated words" })).toBe("https://a.com");
    expect(tap("https://a.com/x", 2, { below: "next", wrapsToBelow: false })).toBe("https://a.com/x");
  });

  it("joins a URL that WRAPS: tapping the head on the wrapping line", () => {
    expect(
      tap("visit https://example.com/very/long/path", 20, {
        below: "/page-2 done here",
        wrapsToBelow: true,
      }),
    ).toBe("https://example.com/very/long/path/page-2");
  });

  it("joins a URL that WRAPS: tapping the tail on the line below", () => {
    expect(
      tap("/page-2 done here", 0, {
        above: "visit https://example.com/very/long/path",
        wrappedFromAbove: true,
      }),
    ).toBe("https://example.com/very/long/path/page-2");
  });

  it("a three-segment wrap joins both seams when the tap sits in the middle", () => {
    expect(
      tap("/seam/one", 1, {
        above: "log: https://ex.io/zero",
        below: "/two end",
        wrappedFromAbove: true,
        wrapsToBelow: true,
      }),
    ).toBe("https://ex.io/zero/seam/one/two");
  });

  it("a wrapped tail that trails punctuation still opens clean", () => {
    expect(tap("le. end of message", 0, { above: "https://ex.io/a/deep/path/to/fidd", wrappedFromAbove: true })).toBe(
      "https://ex.io/a/deep/path/to/fiddle",
    );
  });

  it("a tail tapped after a HARD-newlined row is not joined", () => {
    // The line above ends with a URL, but it ended on a newline: wrappedFromAbove false.
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

describe("urlTokenAt with wide glyphs (cells are not string indices)", () => {
  // "参考 https://a.com/x 打开 https://b.com/y" in CELLS:
  // 参 0-1 · 考 2-3 · ␠4 · first URL 5..19 · ␠20 · 打 21-22 · 开 23-24 · ␠25 · second URL 26..40
  const line = "参考 https://a.com/x 打开 https://b.com/y";

  it("a tap on 打开 opens NOTHING — it must not walk back into the first URL", () => {
    expect(tap(line, 21)).toBeNull();
    expect(tap(line, 22)).toBeNull(); // even the right-hand cell of a wide glyph
    expect(tap(line, 23)).toBeNull();
    expect(tap(line, 24)).toBeNull();
  });

  it("a tap on each URL's cells opens exactly that URL", () => {
    expect(tap(line, 5)).toBe("https://a.com/x");
    expect(tap(line, 19)).toBe("https://a.com/x");
    expect(tap(line, 26)).toBe("https://b.com/y");
    expect(tap(line, 40)).toBe("https://b.com/y");
  });

  it("a tap on the spaces between tokens opens nothing", () => {
    expect(tap(line, 4)).toBeNull();
    expect(tap(line, 20)).toBeNull();
    expect(tap(line, 25)).toBeNull();
  });

  it("a wrapped URL whose head line carries wide chars still joins", () => {
    expect(
      tap("查看 https://ex.io/very/long/pa", 5, {
        below: "th/page tail",
        wrapsToBelow: true,
      }),
    ).toBe("https://ex.io/very/long/path/page");
  });

  it("a combining mark rides its base's cell and shifts nothing", () => {
    // "cast" with an e + U+0301: the mark owns no cell, so the URL still
    // starts at cell 5 and a tap at its start opens the URL.
    const line = "éast https://comb.dev/x";
    expect(tap(line, 7)).toBe("https://comb.dev/x");
    expect(tap(line, 1)).toBeNull(); // the é cell: a word, not a URL
  });
});

describe("cellToCharIndex (cell column → string unit)", () => {
  it("maps ASCII cells one-to-one", () => {
    expect(cellToCharIndex("abc", 0)).toBe(0);
    expect(cellToCharIndex("abc", 2)).toBe(2);
    expect(cellToCharIndex("abc", 3)).toBeNull(); // past the text
  });

  it("answers for the same code point on both cells of a wide glyph", () => {
    expect(cellToCharIndex("参a", 0)).toBe(0);
    expect(cellToCharIndex("参a", 1)).toBe(0); // the wide glyph's second cell
    expect(cellToCharIndex("参a", 2)).toBe(1); // and the ASCII after it
  });

  it("zero-width code points never own a cell", () => {
    // "éa": é (1 cell) then a (1 cell) — cell 1 is the "a".
    expect(cellToCharIndex("éa", 1)).toBe(2);
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
