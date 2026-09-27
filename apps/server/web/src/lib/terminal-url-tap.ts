import type { Terminal } from "@xterm/xterm";

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
 * - CELLS are not string indices. A CJK glyph is one UTF-16 unit occupying
 *   TWO cells, and a combining mark rides its base's cell for free, so the
 *   tapped column must be walked through the line's code points to find the
 *   unit under it. Comparing the raw column against string offsets would
 *   resolve a tap west of a wide run into a token the user never touched
 *   (review 2026-09-27: a tap on 打开 in "参考 https://a.com/x 打开
 *   https://b.com/y" walked back into the FIRST url).
 * - The wrap seam is a fact the buffer carries, not a guess from text
 *   length: `getLine(i).isWrapped`. A row whose trimmed text happens to fill
 *   the width after a HARD newline is not a continuation; treating it as one
 *   joins two unrelated lines. So the caller hands over `wrappedFromAbove`
 *   (this row's own isWrapped) and `wrapsToBelow` (the NEXT row's
 *   isWrapped) and no length stands in for either.
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
 * The cell cost of a code point on the grid: 0 rides its base's cell
 * (combining marks, variation selectors, ZWJ), 2 spans two cells (CJK,
 * Hangul, fullwidth forms, emoji), 1 everything else. A pragmatic
 * wcwidth subset — the ranges that actually occur in terminal output —
 * because the buffer API that would answer this exactly lives per-CELL
 * (`getCell(x).width`) while the token walk lives per STRING, and this
 * function is the bridge between the two.
 *
 * @param cp - the code point to measure
 */
export function codePointCellWidth(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining marks above/below
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining marks DiA... extended
    (cp >= 0x20d0 && cp <= 0x20f0) || // combining marks for symbols
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners/marks
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) // combining half marks
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo init.
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, Hangul compat Jamo, enclosed CJK
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms, small form variants
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth ASCII variants
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
    (cp >= 0x17000 && cp <= 0x18aff) || // Tangut
    (cp >= 0x1f004 && cp <= 0x1f9ff) || // emoji, mahjong, enclosed alphanumerics…
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B–F
  ) {
    return 2;
  }
  return 1;
}

/**
 * The string index of the code point occupying a cell column, or null when
 * the cell is past the line's text (a blank buffer cell) or before 0. A wide
 * glyph answers for BOTH of its cells; zero-width code points never own a
 * cell, so a column answers its base.
 *
 * @param line - the row's text, trailing whitespace trimmed
 * @param col - the tapped cell column (0-based, as xterm counts cells)
 */
export function cellToCharIndex(line: string, col: number): number | null {
  if (col < 0) return null;
  let cell = 0;
  for (let i = 0; i < line.length; ) {
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = codePointCellWidth(cp);
    if (w === 0) {
      // Rides the previous cell; never owns the tap.
      i += ch.length;
      continue;
    }
    if (col < cell + w) return i;
    cell += w;
    i += ch.length;
  }
  return null;
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
 * Inputs for one tap: the buffer text around it, the tapped CELL, and the
 * two wrap facts. Lines are as `translateToString(true)` yields them —
 * trailing whitespace trimmed, which together with the wrap flags makes the
 * seam rules exact: a wrapped row's trimmed text ends in the very glyph that
 * caused the wrap, and a hard-newlined row is never joined because the
 * buffer says so. One non-exact shape, ACCEPTED: when a WIDE glyph (a CJK
 * cell) itself straddles the wrap seam, xterm splits it into a base cell + a
 * continuation cell and the head-side join sees the continuation as a blank
 * leading token, so it MISSES (returns the URL up to the seam, or null)
 * rather than ever wrong-opening; the tail-side tap still joins correctly.
 * Miss-open only, never a wrong URL — the reason this is left as-is.
 */
export interface TapCellText {
  /** Text of the tapped line. */
  line: string;
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
 * @param text - the tapped line, its neighbours, the tapped cell, the wrap facts
 * @returns the URL to open, or null for a plain word, whitespace, or a cell
 *          past the text
 */
export function urlTokenAt({ line, above, below, col, wrappedFromAbove, wrapsToBelow }: TapCellText): string | null {
  const index = cellToCharIndex(line, col);
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
 * and the WRAP FACTS from `isWrapped` on this row and the one below — the
 * buffer's own record of where lines actually continue.
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
  const line = buffer.getLine(lineIndex)?.translateToString(true) ?? "";
  return urlTokenAt({
    line,
    above: buffer.getLine(lineIndex - 1)?.translateToString(true),
    below: buffer.getLine(lineIndex + 1)?.translateToString(true),
    col: point.col,
    wrappedFromAbove: buffer.getLine(lineIndex)?.isWrapped === true,
    wrapsToBelow: buffer.getLine(lineIndex + 1)?.isWrapped === true,
  });
}
