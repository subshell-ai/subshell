import type { Terminal } from "@xterm/xterm";

/**
 * "Tap the link you printed" for copy mode (issue 242, touch): a phone has
 * no hover and a long-press cannot aim at one character of a URL, so a CLEAN
 * tap in copy mode looks up the token under the finger and opens it when it
 * is an http(s) URL. The scheme decision itself is `terminal-url-open`'s;
 * this module's job ends at "which token, is it a URL".
 *
 * The hard part is that terminal text WRAPS: a URL longer than the column
 * count is split across two buffer lines with no space at the seam, and the
 * tap can land on either half. A wrapped line is recognisable by one fact —
 * its text runs to the LAST column (a soft-wrapped cell has nothing to its
 * right, while a hard break leaves a trailing space that
 * `translateToString(true)` trimmed away). So a join across a line boundary
 * is only attempted when the edge line is full width and the neighbour line
 * starts mid-token: `https://a.com/` + `very/long` on a full line is the
 * same URL; `https://a.com` followed by an unrelated word that merely
 * starts the next line is not joined.
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

function stripTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_STRIP.includes(value[end - 1]!)) end--;
  return value.slice(0, end);
}

/** The whitespace-delimited token at `col`, with its bounds, or null when
 * `col` sits on whitespace or past the text. */
function tokenAt(line: string, col: number): { token: string; start: number; end: number } | null {
  if (col < 0 || col >= line.length || isDelimiter(line[col]!)) return null;
  let start = col;
  while (start > 0 && !isDelimiter(line[start - 1]!)) start--;
  let end = col;
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
 * Inputs for one tap: the buffer text around it plus the grid width.
 * Lines are as `translateToString(true)` yields them (trailing whitespace
 * trimmed — the trim is what makes "runs to the last column" testable).
 */
export interface TapCellText {
  /** Text of the tapped line. */
  line: string;
  /** The line above, if it exists. */
  above?: string;
  /** The line below, if it exists. */
  below?: string;
  /** Column of the tapped cell within `line`. */
  col: number;
  /** Buffer width: a line whose trimmed text is this long wrapped at the edge. */
  cols: number;
}

function accept(candidate: string): string | null {
  const stripped = stripTrailingPunctuation(candidate);
  return URL_RE.test(stripped) ? stripped : null;
}

/**
 * The URL the tapped cell belongs to, or null.
 *
 * Three shapes, in order: the token at the tap is itself the URL (extended
 * by the next line's first token when it ran to the wrap edge); the token is
 * the TAIL of a URL that wrapped in from a full-width line above; the token
 * is the HEAD of one continuing onto the next line. Punctuation trailing the
 * final candidate is stripped; a candidate that was not a URL before the
 * join cannot become one after it is checked.
 *
 * @param text - the tapped line, its neighbours, the tapped column, the width
 * @returns the URL to open, or null for a plain word, whitespace, or a col
 *          past the text
 */
export function urlTokenAt({ line, above, below, col, cols }: TapCellText): string | null {
  const hit = tokenAt(line, col);
  if (!hit) return null;
  const wrapsRight = line.length >= cols && hit.end === line.length - 1;
  const wrapsLeft = hit.start === 0;
  if (URL_RE.test(hit.token)) {
    if (wrapsRight && below) {
      const next = leadingToken(below);
      if (next) return accept(hit.token + next);
    }
    return accept(hit.token);
  }
  if (wrapsLeft && above && above.length >= cols) {
    const prev = trailingToken(above);
    if (prev) {
      const joined = prev + hit.token;
      if (URL_RE.test(joined)) {
        if (wrapsRight && below) {
          const next = leadingToken(below);
          if (next) return accept(joined + next);
        }
        return accept(joined);
      }
    }
  }
  if (wrapsRight && below) {
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
 * same `dimensions.css.cell` the letterbox already reads), and the LINE from
 * the ACTIVE viewport: `buffer.active.viewportY` shifts with the client
 * scroll, so a tap on a row paged up out of the prompt finds that row's own
 * text, not what the prompt would show there.
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
    cols: term.cols,
  });
}
