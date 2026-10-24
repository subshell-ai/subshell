import { describe, expect, it } from "bun:test";
import {
  cellAtPoint,
  type TapCell,
  type TapCellText,
  type TapRow,
  tapCellsOfLine,
  urlTokenAt,
} from "@internal/subshell-protocol";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/xterm";

/**
 * Two sources of cells feed these tests, and both matter:
 *
 * - `asciiCells` measures a test's own string one unit per cell. That is a
 *   PROVIDER decision made here in the harness, not module knowledge: the
 *   module reads the measurements it is handed and owns no width table.
 * - `bufferTap` writes into a REAL `@xterm/xterm` (and, when asked, the
 *   graphemes addon) and lifts the cells out of the live buffer through
 *   `tapCellsOfLine` — the same reader `terminalUrlAtPoint` uses. Whatever
 *   provider laid the line out, the tap follows its cells.
 */

const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 👨‍👩‍👧

/**
 * One tap at a CELL column, with the wrap facts the buffer would carry.
 * Neighbours arrive through `read(offset)`, the way a real chain arrives: a
 * URL can wrap across any number of rows, so the tap is told about rows, not
 * about one neighbour each way. `above`/`below`/`wrappedFromAbove`/
 * `wrapsToBelow` build that reader for the common two-row cases; `read`
 * supplies the whole chain directly when a test needs more rows than that.
 */
function tap(
  line: string,
  col: number,
  opts: {
    read?: (offset: number) => TapRow | undefined;
    above?: string;
    below?: string;
    wrappedFromAbove?: boolean;
    wrapsToBelow?: boolean;
    cells?: TapCell[];
  } = {},
) {
  const read =
    opts.read ??
    ((offset: number): TapRow | undefined =>
      offset === 0
        ? { text: line, wrapped: opts.wrappedFromAbove ?? false }
        : offset === 1 && opts.below !== undefined
          ? { text: opts.below, wrapped: opts.wrapsToBelow ?? false }
          : offset === -1 && opts.above !== undefined
            ? { text: opts.above, wrapped: false }
            : undefined);
  const input: TapCellText = { line, cells: opts.cells ?? asciiCells(line), col, read };
  return urlTokenAt(input);
}

/** A row chain for `read(offset)`: keyed by offset, offset 0 is the tapped row. */
function chain(rows: Record<number, TapRow>): (offset: number) => TapRow | undefined {
  return (offset) => rows[offset];
}

/** The harness's own provider: one cell per code point, one column each. */
function asciiCells(line: string): TapCell[] {
  return Array.from(line, (char) => ({ char, width: 1 }));
}

async function makeTerminal(cols: number, graphemes: boolean): Promise<Terminal> {
  const term = new Terminal({ cols, rows: 8, allowProposedApi: true });
  if (graphemes) term.loadAddon(new UnicodeGraphemesAddon());
  return term;
}

async function write(term: Terminal, data: string): Promise<void> {
  term.write(data);
  // xterm's write queue is async; the empty write's callback flushes it.
  await new Promise<void>((resolve) => term.write("", () => resolve()));
}

function tapBufferRow(term: Terminal, row: number, col: number): string | null {
  const buffer = term.buffer.active;
  const line = buffer.getLine(row);
  if (!line) return null;
  const text = line.translateToString(true);
  return urlTokenAt({
    line: text,
    cells: tapCellsOfLine(line, text),
    col,
    read: (offset) => {
      const r = buffer.getLine(row + offset);
      return r ? { text: r.translateToString(true), wrapped: r.isWrapped === true } : undefined;
    },
  });
}

/** One tap against a REAL buffer: line, cells, neighbours and both wrap
 * facts all come out of `term` exactly as `terminalUrlAtPoint` takes them
 * (minus the DOM hit-test, which `cellAtPoint` covers on its own). */
async function bufferTap(
  data: string,
  col: number,
  opts: { cols?: number; row?: number; graphemes?: boolean } = {},
): Promise<string | null> {
  const term = await makeTerminal(opts.cols ?? 80, opts.graphemes ?? true);
  await write(term, data);
  return tapBufferRow(term, opts.row ?? 0, col);
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

  it("drops the control notation a cat -v style dump trails the URL with", () => {
    // `cat -v` renders a CR as the two characters "^M", and they glue onto
    // the URL token at the whitespace model. The notation is display, not
    // part of the address: a tap must open the URL, not a 404 with "^M"
    // percent-encoded onto the end of it.
    expect(tap("https://example.com/path^M", 4)).toBe("https://example.com/path");
    expect(tap("https://example.com/path^M.", 4)).toBe("https://example.com/path"); // notation then prose period
    expect(tap("https://example.com/path^J^M", 4)).toBe("https://example.com/path"); // two notations
    // DEL's spelling `^?`: the `?` is also prose punctuation, so the pair
    // must be read before the `?` is stripped and dissolves the notation.
    expect(tap("https://example.com/path^?", 4)).toBe("https://example.com/path");
    // A caret mid-token is data the program printed: only the TAIL is junk.
    expect(tap("https://example.com/a^Mb", 4)).toBe("https://example.com/a^Mb");
    // A bare caret at the end is not a control pair and stays.
    expect(tap("https://example.com/path^", 4)).toBe("https://example.com/path^");
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

  it("a three-row wrap joins ALL rows when the tap sits on the head", () => {
    // The seam-worth case from the field: a long URL soft-wraps down past a
    // second seam, and the tap lands on the FIRST row. One row of lookahead
    // returns a truncated URL that opens a dead page; the chain walk returns
    // the whole token.
    const rows = chain({
      0: { text: "log: https://ex.io/zero", wrapped: false },
      1: { text: "/seam/one", wrapped: true },
      2: { text: "/two end", wrapped: true },
    });
    expect(tap("log: https://ex.io/zero", 5, { read: rows })).toBe("https://ex.io/zero/seam/one/two");
  });

  it("a three-row wrap joins ALL rows when the tap sits on the tail", () => {
    const rows = chain({
      [-2]: { text: "log: https://ex.io/zero", wrapped: false },
      [-1]: { text: "/seam/one", wrapped: true },
      0: { text: "/two end", wrapped: true },
    });
    expect(tap("/two end", 0, { read: rows })).toBe("https://ex.io/zero/seam/one/two");
  });

  it("the chain walk stops at a HARD newline mid-chain", () => {
    // Row 2 does NOT record itself as a continuation, so the seam between 1
    // and 2 is a real line break: the join stops at row 1's token.
    const rows = chain({
      0: { text: "log: https://ex.io/zero", wrapped: false },
      1: { text: "/seam/one", wrapped: true },
      2: { text: "/NOTpart end", wrapped: false },
    });
    expect(tap("log: https://ex.io/zero", 5, { read: rows })).toBe("https://ex.io/zero/seam/one");
  });

  it("a four-row wrap is walked whole from the row where the URL starts", () => {
    const rows = chain({
      0: { text: "get https://ex.io/a", wrapped: false },
      1: { text: "/b", wrapped: true },
      2: { text: "/c", wrapped: true },
      3: { text: "/d done", wrapped: true },
    });
    expect(tap("get https://ex.io/a", 4, { read: rows })).toBe("https://ex.io/a/b/c/d");
    // …and from the LAST content row upward: same chain, offsets rebased so 0
    // is that row (offsets are relative to the tap, the way the buffer hands
    // them over).
    expect(
      tap("/d done", 0, {
        read: chain({
          [-3]: { text: "get https://ex.io/a", wrapped: false },
          [-2]: { text: "/b", wrapped: true },
          [-1]: { text: "/c", wrapped: true },
          0: { text: "/d done", wrapped: true },
        }),
      }),
    ).toBe("https://ex.io/a/b/c/d");
  });

  it("a real buffer walk: one URL wrapped across THREE rows opens whole from every row", async () => {
    // cols=20 forces the seams; the head, middle and tail rows must all
    // answer with the full URL — this is the replay/screenshot case, where
    // the viewer's buffer carries the seams and the tap must follow them.
    const url = "https://ex.io/aaaa/bbbb/cccc/dddd/eeee/ffff";
    const data = `go ${url} tail\r\n`;
    expect(await bufferTap(data, 3, { cols: 20, row: 0 })).toBe(url);
    expect(await bufferTap(data, 0, { cols: 20, row: 1 })).toBe(url);
    expect(await bufferTap(data, 0, { cols: 20, row: 2 })).toBe(url);
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
  // "参考 https://a.com/x 打开 https://b.com/y" in CELLS (measured by a real
  // buffer; both providers agree on CJK):
  // 参 0-1 · 考 2-3 · ␠4 · first URL 5..19 · ␠20 · 打 21-22 · 开 23-24 · ␠25 · second URL 26..40
  const line = "参考 https://a.com/x 打开 https://b.com/y";

  for (const graphemes of [true, false]) {
    const label = graphemes ? "(graphemes addon)" : "(core tables)";

    it(`a tap on 打开 opens NOTHING — it must not walk back into the first URL ${label}`, async () => {
      expect(await bufferTap(`${line}\r\n`, 21, { graphemes })).toBeNull();
      expect(await bufferTap(`${line}\r\n`, 22, { graphemes })).toBeNull(); // even the right-hand cell of a wide glyph
      expect(await bufferTap(`${line}\r\n`, 23, { graphemes })).toBeNull();
      expect(await bufferTap(`${line}\r\n`, 24, { graphemes })).toBeNull();
    });

    it(`a tap on each URL's cells opens exactly that URL ${label}`, async () => {
      expect(await bufferTap(`${line}\r\n`, 5, { graphemes })).toBe("https://a.com/x");
      expect(await bufferTap(`${line}\r\n`, 19, { graphemes })).toBe("https://a.com/x");
      expect(await bufferTap(`${line}\r\n`, 26, { graphemes })).toBe("https://b.com/y");
      expect(await bufferTap(`${line}\r\n`, 40, { graphemes })).toBe("https://b.com/y");
    });

    it(`a tap on the spaces between tokens opens nothing ${label}`, async () => {
      expect(await bufferTap(`${line}\r\n`, 4, { graphemes })).toBeNull();
      expect(await bufferTap(`${line}\r\n`, 20, { graphemes })).toBeNull();
      expect(await bufferTap(`${line}\r\n`, 25, { graphemes })).toBeNull();
    });
  }

  it("a wrapped URL whose head line carries wide chars still joins (real seam)", async () => {
    // cols=31 puts the seam exactly where the old hand-built case had it:
    // 查 0-1 · 看 2-3 · ␠4 · "https://ex.io/very/long/pa" 5..30, then
    // "th/page tail" soft-wraps to row 1. The tap walks real cells to the
    // URL's start, and the join reads the NEXT row's first token.
    expect(await bufferTap("查看 https://ex.io/very/long/path/page tail", 5, { cols: 31, row: 0 })).toBe(
      "https://ex.io/very/long/path/page",
    );
    // …and the same seam tapped from below resolves the tail upward.
    expect(await bufferTap("查看 https://ex.io/very/long/path/page tail", 0, { cols: 31, row: 1 })).toBe(
      "https://ex.io/very/long/path/page",
    );
  });

  it("a combining mark rides its base's cell and shifts nothing", async () => {
    // "e\u0301ast https://comb.dev/x" with the mark spelled (e + U+0301): both
    // providers pack it into the base's cell (core at input, the addon as
    // one grapheme), so the URL starts at cell 5 either way — the mark
    // never owns a column.
    expect(await bufferTap("e\u0301ast https://comb.dev/x\r\n", 7)).toBe("https://comb.dev/x");
    expect(await bufferTap("e\u0301ast https://comb.dev/x\r\n", 7, { graphemes: false })).toBe("https://comb.dev/x");
    expect(await bufferTap("e\u0301ast https://comb.dev/x\r\n", 1)).toBeNull(); // the é cell: a word, not a URL
  });

  it("the CELLS are the only measurement the module consults", () => {
    // The harness LIES: a width-1 cell for a glyph every width table calls
    // wide. urlTokenAt must follow the lie (it reads measurements, never
    // computes them): the lie puts the URL at cells 2..12, where the honest
    // measure would put it at 3..13.
    const lie: TapCell[] = [{ char: "参", width: 1 }, ...asciiCells(" https://a.io")];
    expect(tap("参 https://a.io", 2, { cells: lie })).toBe("https://a.io");
    expect(tap("参 https://a.io", 1, { cells: lie })).toBeNull(); // the space, on the lie's grid
    const honest: TapCell[] = [{ char: "参", width: 2 }, { char: "", width: 0 }, ...asciiCells(" https://a.io")];
    expect(tap("参 https://a.io", 2, { cells: honest })).toBeNull(); // the space, on the honest grid
    expect(tap("参 https://a.io", 3, { cells: honest })).toBe("https://a.io");
    expect(tap("参 https://a.io", 1, { cells: honest })).toBeNull(); // the glyph's RIGHT cell answers the glyph
  });
});

describe("tapCellsOfLine (the buffer reader)", () => {
  it("returns exactly the cells the trimmed text was built from", async () => {
    const term = await makeTerminal(10, true);
    await write(term, "abcdefghij参尾\r\n");
    // row 0: 10 glyphs would need cols 0..9 and 参 needs two, so xterm
    // moves the WHOLE glyph to row 1 (measured 2026-09-26) and row 0 ends
    // on a trailing blank — trimmed away with the text, not a tap cell.
    const row0 = term.buffer.active.getLine(0)!;
    const text0 = row0.translateToString(true);
    expect(text0).toBe("abcdefghij");
    expect(tapCellsOfLine(row0, text0)).toEqual(asciiCells(text0));
    // row 1: 参尾 = base + zero-width continuation per glyph. The reader
    // stops when the trimmed text is covered: 尾's own continuation
    // contributes no text and no column beyond the base's own width 2.
    const row1 = term.buffer.active.getLine(1)!;
    const text1 = row1.translateToString(true);
    expect(text1).toBe("参尾");
    expect(tapCellsOfLine(row1, text1)).toEqual([
      { char: "参", width: 2 },
      { char: "", width: 0 },
      { char: "尾", width: 2 },
    ]);
  });

  it("a wide glyph ending the line keeps BOTH its columns through the base", async () => {
    // Measured 2026-09-26 (input at cols 12, and again through resizes):
    // xterm never splits a wide glyph across the wrap seam. At a line end
    // the glyph sits whole, its width covering both of its columns, with
    // the width-0 continuation contributing no text — so the reader ends
    // at the base and a tap on the glyph's RIGHT cell still resolves to
    // the glyph, never past the seam.
    const term = await makeTerminal(12, true);
    await write(term, "abcdefghij参\r\n尾尾\r\n");
    const line = term.buffer.active.getLine(0)!;
    const text = line.translateToString(true);
    expect(text).toBe("abcdefghij参");
    const cells = tapCellsOfLine(line, text);
    expect(cells.at(-1)).toEqual({ char: "参", width: 2 });
    for (const col of [10, 11]) {
      expect(urlTokenAt({ line: text, cells, col })).toBeNull();
    }
  });
});

describe("providers own the widths, the tap follows (ZWJ sequences)", () => {
  it("with the addon the family emoji is ONE width-2 cell, and the URL starts at its right", async () => {
    const term = await makeTerminal(20, true);
    await write(term, `${FAMILY} https://fam.dev/x\r\n`);
    const line = term.buffer.active.getLine(0)!;
    const text = line.translateToString(true);
    expect(tapCellsOfLine(line, text)).toEqual([
      { char: FAMILY, width: 2 },
      { char: "", width: 0 },
      ...asciiCells(" https://fam.dev/x"),
    ]);
    expect(await bufferTap(`${FAMILY} https://fam.dev/x\r\n`, 3, { graphemes: true })).toBe("https://fam.dev/x");
    expect(await bufferTap(`${FAMILY} https://fam.dev/x\r\n`, 0, { graphemes: true })).toBeNull(); // the emoji itself
    expect(await bufferTap(`${FAMILY} https://fam.dev/x\r\n`, 2, { graphemes: true })).toBeNull(); // its continuation
  });

  it("without the addon core splits the same emoji across THREE cells, and the tap still follows", async () => {
    // This is the mis-column the addon fixes for RENDERING; the tap map
    // does not care, because it reads whichever provider laid the line out.
    // The exact fragments core leaves in the three cells are internal (they
    // carry the ZWJs); the widths and where the URL actually sits are the
    // contract, so that is what is pinned.
    const term = await makeTerminal(20, false);
    await write(term, `${FAMILY} https://fam.dev/x\r\n`);
    const line = term.buffer.active.getLine(0)!;
    const text = line.translateToString(true);
    const cells = tapCellsOfLine(line, text);
    expect(cells.slice(0, 3).map((c) => c.width)).toEqual([1, 1, 1]);
    expect(await bufferTap(`${FAMILY} https://fam.dev/x\r\n`, 4, { graphemes: false })).toBe("https://fam.dev/x");
    expect(await bufferTap(`${FAMILY} https://fam.dev/x\r\n`, 0, { graphemes: false })).toBeNull();
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
