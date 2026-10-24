import { cellAtPoint, tapCellsOfLine, urlTokenAt } from "@internal/subshell-protocol";
import type { Terminal } from "@xterm/xterm";

/**
 * "Tap the link you printed" for copy mode (issue 242, touch): a phone has
 * no hover and a long-press cannot aim at one character of a URL, so a CLEAN
 * tap in copy mode looks up the token under the finger and opens it when it
 * is an http(s) URL. The scheme decision itself is `terminal-url-open`'s;
 * this module's job ends at "which token, is it a URL".
 *
 * The token model — cell-vs-string-index mapping, the `isWrapped` seam walk,
 * trailing-junk stripping — is the shared core in `@internal/subshell-protocol`
 * (`pane-url.ts`), which the mobile app's bundled page and Log tab run too,
 * so a tap means the same thing on every device. Read that module's header
 * for why the mappings are shaped as they are (measured wide-glyph and seam
 * behavior, the strip-order trap). What lives HERE is only the xterm
 * adapter: where on the live terminal the tap landed, which buffer row that
 * is, and how to hand the core its measured cells and seam reader.
 */

/**
 * The URL under a client-space point on a live terminal, scrollback included.
 *
 * The cell comes from `.xterm-screen`'s rect over the measured cell (the
 * same `dimensions.css.cell` the letterbox already reads), the LINE from the
 * ACTIVE viewport (`buffer.active.viewportY` shifts with the client scroll,
 * so a tap on a row paged up out of the prompt finds that row's own text),
 * the CELLS from that same line through `tapCellsOfLine` — the provider
 * that laid the row out is what the tap follows — and the seam CHAIN from
 * `isWrapped` row by row outward, the buffer's own record of where lines
 * actually continue.
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
    col: point.col,
    read: (offset) => {
      const row = buffer.getLine(lineIndex + offset);
      if (!row) return undefined;
      return { text: row.translateToString(true), wrapped: row.isWrapped === true };
    },
  });
}
