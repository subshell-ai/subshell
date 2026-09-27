import type { IBufferLine, Terminal } from "@xterm/xterm";

/**
 * "Tap the link you printed" for copy mode (issue 242, touch): a phone has
 * no hover and a long-press cannot aim at one character of a URL, so a CLEAN
 * tap in copy mode looks up the token under the finger and opens it when it
 * is an http(s) URL. The scheme decision itself is `terminal-url-open`'s;
 * this module's job ends at "which token, is it a URL".
 *
 * Two mappings carry the whole risk, and both speak BUFFER FACTS rather than
 * length guesses:
 *
 * - CELLS are not string indices. A CJK glyph owns TWO cells and a wide
 *   glyph's zero-width continuation rides its base, so the tapped column
 *   must be walked through the row's MEASURED CELLS to find the unit under
 *   it. This module used to own a hand-rolled wcwidth table as that bridge
 *   (review 2026-09-27: the table was how a tap west of a wide run failed
 *   to walk into a token the user never touched); it now reads the widths
 *   the ACTIVE provider laid the row out with — the buffer's own cell data
 *   (`tapCellsOfLine`), which is the grapheme truth under the unicode-
 *   graphemes addon (2026-09-26 wave) and core's tables anywhere the addon
 *   is not loaded. NO width knowledge may live here: it reads measurements,
 *   never computes them.
 * - The wrap seam is a fact the buffer carries, not a guess from text
 *   length: `getLine(i).isWrapped`. A row whose trimmed text happens to fill
 *   the width after a HARD newline is not a continuation; treating it as one
 *   joins two unrelated lines. So the caller hands over `wrappedFromAbove`
 *   (this row's own isWrapped) and `wrapsToBelow` (the NEXT row's
 *   isWrapped) and no length stands in for either.
 *
 * The seam and a wide glyph, MEASURED 2026-09-26 on xterm 6.1.0-beta.304
 * (both providers; at input time and again through resizes): xterm never
 * splits a wide glyph across the wrap seam. Either the whole glyph moves to
 * the next row (which starts on it, `isWrapped` flagging the seam), or it
 * ENDS this row whole — base cell plus its zero-width continuation, which
 * contributes no text — so the trimmed text ends on the glyph that owns the
 * row's last cells, and both join rules below read real glyphs. What that
 * leaves is the token model itself, ACCEPTED and unchanged by the addon:
 * a token is whatever runs between whitespace, so a CJK word abutting the
 * seam (prose has no spaces) glues onto a seam-ending URL exactly as an
 * ASCII continuation would — identical before and after this refactor.
 */

/** A token is whatever runs between whitespace (or the line's ends). A
 * buffer cell is blank as a space; a literal tab splits too. */
const isDelimiter = (ch: string): boolean => ch === " " || ch === "\t";

/** Punctuation stripped from the END of a candidate: prose trails a URL with
 * these, and every real-world URL that ends in one of them ends wrong for a
 * human anyway. Leading punctuation is NOT stripped — a token starting with
 * `(` or `"` is not what a URL-shaped token looks like, and guessing is how
 * a tap opens the wrong thing. Bracket balance is out of scope. */
const TRAILING_STRIP = ")[.,;:!?\"'";

const URL_RE = /^https?:\/\//i;

/**
 * One MEASURED buffer cell: the glyph it carries and the columns it owns.
 * Widths come from whoever laid the row out (the graphemes addon, core's
 * tables — this module never decides): `width` 2 is a wide glyph owning two
 * columns, 0 is a continuation or a zero-width carry owning none, 1 is
 * ordinary. `char` is the cell's text as the buffer stores it — which may
 * be a whole grapheme cluster (the addon packs 👨‍👩‍👧 into ONE cell), a base
 * with its marks (core packs them too), "" for a continuation, and "" for a
 * blank cell (which `translateToString` renders as a space).
 */
export interface TapCell {
  /** The cell's text as the buffer stores it (may be multiple code points). */
  char: string;
  /** Columns this cell owns: 1 ordinary, 2 wide glyph, 0 continuation/zero-width. */
  width: number;
}

/**
 * The string index of the code point occupying a cell column, or null when
 * the column is past the cells' own width (a blank buffer cell) or below 0.
 * A wide cell answers for BOTH of its columns; zero-width cells never own a
 * column, so a column lands on the next cell that does — a combining carry
 * or a wide continuation resolves to whatever base owns the tap.
 *
 * @param cells - the tapped line's measured cells (see {@link tapCellsOfLine})
 * @param col - the tapped cell column (0-based, as xterm counts cells)
 */
function cellIndexAt(cells: TapCell[], col: number): number | null {
  if (col < 0) return null;
  let column = 0;
  let index = 0;
  for (const cell of cells) {
    if (cell.width > 0) {
      if (col < column + cell.width) return index;
      column += cell.width;
    }
    index += stringUnitsOf(cell);
  }
  return null;
}

/** How many of `translateToString`'s string units a cell contributes: its
 * own text, one space when it is a blank cell (the buffer stores "" and the
 * renderer says " "), and nothing at width 0 (continuations are skipped).
 * The tap walk and the buffer reader step the string by this rule so the
 * two agree about where every cell sits in `line`. */
const stringUnitsOf = (cell: TapCell): number => (cell.char ? cell.char.length : cell.width > 0 ? 1 : 0);

/**
 * Read a buffer line's cells, in the {@link TapCell} shape, covering exactly
 * the text `translateToString(true)` yielded: the walk stops when the
 * trimmed string is covered, so trailing blanks — and the zero-width
 * continuation of a glyph that ENDS the row — are not cells of this tap
 * (the base's own width already owns both of its columns; measured
 * 2026-09-26). This is the module's ONLY reader of the live buffer; the tap
 * mapping stays pure on the array it produces.
 *
 * @param line - the buffer line (`getLine(index)`)
 * @param trimmed - that same line's `translateToString(true)`
 */
export function tapCellsOfLine(line: IBufferLine, trimmed: string): TapCell[] {
  const cells: TapCell[] = [];
  let seen = 0;
  for (let x = 0; x < line.length && seen < trimmed.length; x++) {
    // No reuse cursor: `getNullCell` lives on the BUFFER and exists for
    // per-cell sweeps; a tap reads one line.
    const cell = line.getCell(x);
    if (!cell) break;
    const char = cell.getChars();
    const width = cell.getWidth();
    cells.push({ char, width });
    seen += stringUnitsOf({ char, width });
  }
  return cells;
}

/** The whitespace-delimited token at a STRING index, with its bounds, or
 * null when the index sits on whitespace. */
function tokenAt(line: string, index: number): { token: string; start: number; end: number } | null {
  if (index < 0 || index >= line.length || isDelimiter(line[index]!)) return null;
  let start = index;
  while (start > 0 && !isDelimiter(line[start - 1]!)) start--;
  let end = index;
  while (end + 1 < line.length && !isDelimiter(line[end + 1]!)) end++;
  return { token: line.slice(start, end + 1), start, end };
}

/** The first token of a line, iff the line starts on one (the head of a
 * line that begins with whitespace cannot continue anything). */
function leadingToken(line: string): string | null {
  if (!line.length || isDelimiter(line[0]!)) return null;
  let end = 0;
  while (end < line.length && !isDelimiter(line[end]!)) end++;
  return line.slice(0, end);
}

/** The last token of a line (its right edge). */
function trailingToken(line: string): string | null {
  if (!line.length || isDelimiter(line[line.length - 1]!)) return null;
  let start = line.length;
  while (start > 0 && !isDelimiter(line[start - 1]!)) start--;
  return line.slice(start);
}

/**
 * Inputs for one tap: the buffer text around it, the tapped row's MEASURED
 * CELLS, the tapped CELL, and the two wrap facts. Lines are as
 * `translateToString(true)` yields them — trailing whitespace trimmed, which
 * together with the wrap flags makes the seam rules exact: a wrapped row's
 * trimmed text ends in the very glyph that owns the row's last cells, and a
 * hard-newlined row is never joined because the buffer says so. `cells`
 * must pair with `line` — the same row read through {@link tapCellsOfLine};
 * the seam truth for wide glyphs (and the one ACCEPTED shape that remains,
 * the whitespace-token glue of a seam-abutting CJK word) is in the module
 * header above.
 */
export interface TapCellText {
  /** Text of the tapped line. */
  line: string;
  /** The tapped line's cells, measured by the provider that laid it out. */
  cells: TapCell[];
  /** The line above, if it exists. */
  above?: string;
  /** The line below, if it exists. */
  below?: string;
  /** Column of the tapped CELL within `line` (cells, not string units). */
  col: number;
  /** `getLine(lineIndex).isWrapped` — this row continues the row above. */
  wrappedFromAbove: boolean;
  /** `getLine(lineIndex + 1).isWrapped` — this row runs on into the next. */
  wrapsToBelow: boolean;
}

function stripTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_STRIP.includes(value[end - 1]!)) end--;
  return value.slice(0, end);
}

function accept(candidate: string): string | null {
  const stripped = stripTrailingPunctuation(candidate);
  return URL_RE.test(stripped) ? stripped : null;
}

/**
 * The URL the tapped cell belongs to, or null.
 *
 * Three shapes, in order: the token at the tap is itself the URL (extended
 * by the next row's first token when the wrap facts say the row ran on and
 * the token holds the seam); the token is the TAIL of a URL wrapped in from
 * above; the token is the HEAD of one continuing below. Punctuation trailing
 * the final candidate is stripped. Joining needs the BUFFER's wrap fact —
 * text that merely fills the width after a hard newline is never joined.
 *
 * @param text - the tapped line and its measured cells, the neighbours, the
 *               tapped cell, the wrap facts
 * @returns the URL to open, or null for a plain word, whitespace, or a cell
 *          past the text
 */
export function urlTokenAt({
  line,
  cells,
  col,
  above,
  below,
  wrappedFromAbove,
  wrapsToBelow,
}: TapCellText): string | null {
  const index = cellIndexAt(cells, col);
  if (index === null) return null;
  const hit = tokenAt(line, index);
  if (!hit) return null;
  // A wrapped row's trimmed text ends at the seam, so "token reaches the
  // text end" is exactly "token owns the last cell".
  const holdsRightSeam = wrapsToBelow && hit.end === line.length - 1;
  const holdsLeftSeam = wrappedFromAbove && hit.start === 0;
  if (URL_RE.test(hit.token)) {
    if (holdsRightSeam && below) {
      const next = leadingToken(below);
      if (next) return accept(hit.token + next);
    }
    return accept(hit.token);
  }
  if (holdsLeftSeam && above) {
    const prev = trailingToken(above);
    if (prev) {
      const joined = prev + hit.token;
      if (URL_RE.test(joined)) {
        if (holdsRightSeam && below) {
          const next = leadingToken(below);
          if (next) return accept(joined + next);
        }
        return accept(joined);
      }
    }
  }
  if (holdsRightSeam && below) {
    const next = leadingToken(below);
    if (next) {
      const joined = hit.token + next;
      if (URL_RE.test(joined)) return accept(joined);
    }
  }
  return null;
}

/** Where a client point lands on the visible grid, in cells; null when it
 * landed outside the grid (margin, padding, a scrolled-away row). */
export function cellAtPoint(input: {
  /** Client-space point of the tap. */
  x: number;
  y: number;
  /** `.xterm-screen`'s bounding rect, which the grid exactly fills. */
  rect: { left: number; top: number };
  /** Measured cell size, CSS px. */
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
}): { col: number; row: number } | null {
  if (!(input.cellWidth > 0) || !(input.cellHeight > 0)) return null;
  const col = Math.floor((input.x - input.rect.left) / input.cellWidth);
  const row = Math.floor((input.y - input.rect.top) / input.cellHeight);
  if (col < 0 || col >= input.cols || row < 0 || row >= input.rows) return null;
  return { col, row };
}

/**
 * The URL under a client-space point on a live terminal, scrollback included.
 *
 * The cell comes from `.xterm-screen`'s rect over the measured cell (the
 * same `dimensions.css.cell` the letterbox already reads), the LINE from the
 * ACTIVE viewport (`buffer.active.viewportY` shifts with the client scroll,
 * so a tap on a row paged up out of the prompt finds that row's own text),
 * the CELLS from that same line through `tapCellsOfLine` — the provider
 * that laid the row out is what the tap follows — and the WRAP FACTS from
 * `isWrapped` on this row and the one below, the buffer's own record of
 * where lines actually continue.
 *
 * @param term - the live terminal
 * @param x - client-space X of the tap
 * @param y - client-space Y of the tap
 * @returns the URL the tapped token is, or null
 */
export function terminalUrlAtPoint(term: Terminal, x: number, y: number): string | null {
  const cell = term.dimensions?.css.cell;
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!cell || !screen || !(cell.width > 0) || !(cell.height > 0)) return null;
  const point = cellAtPoint({
    x,
    y,
    rect: screen.getBoundingClientRect(),
    cellWidth: cell.width,
    cellHeight: cell.height,
    cols: term.cols,
    rows: term.rows,
  });
  if (!point) return null;
  const buffer = term.buffer.active;
  const lineIndex = buffer.viewportY + point.row;
  const bufferLine = buffer.getLine(lineIndex);
  if (!bufferLine) return null;
  const line = bufferLine.translateToString(true);
  return urlTokenAt({
    line,
    cells: tapCellsOfLine(bufferLine, line),
    above: buffer.getLine(lineIndex - 1)?.translateToString(true),
    below: buffer.getLine(lineIndex + 1)?.translateToString(true),
    col: point.col,
    wrappedFromAbove: bufferLine.isWrapped === true,
    wrapsToBelow: buffer.getLine(lineIndex + 1)?.isWrapped === true,
  });
}
