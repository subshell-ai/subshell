/**
 * The grid ↔ box arithmetic that inverts terminal sizing.
 *
 * Sizing used to run one way — box → grid: FitAddon measured the pane's box,
 * set cols/rows from it, and told the server. That makes the client the size
 * authority, which cannot survive two viewers of one pane (a tmux pane has
 * one grid) and cannot survive the server disagreeing: a client that reacts
 * to a correction by re-fitting will trade resizes with the pane forever,
 * which is exactly why commit 6351853's conform step was reverted in eee3a92.
 *
 * So it now runs the other way — authoritative grid + box → box:
 *
 *   1. The client measures its box and reports the grid it COULD show at the
 *      user's font size ({@link gridForBox}). That is a capacity report, not
 *      a demand, and it depends only on the viewport and the font — never on
 *      the grid the terminal currently holds.
 *   2. The server decides the pane's grid and states it (the `geometry`
 *      frame).
 *   3. The client sizes the terminal's own container to exactly that grid
 *      ({@link boxForGrid}) and centres it in the pane.
 *
 * Step 3 is what closes the loop safely: FitAddon, measuring a container that
 * is an exact multiple of the cell size, proposes exactly the authoritative
 * grid, so fitting is idempotent and the terminal never asks for anything
 * different. No acknowledgement, no re-ask, no conform.
 *
 * {@link gridForBox} mirrors `FitAddon.proposeDimensions` deliberately, and
 * `__tests__/terminal-geometry.test.ts` pins it against the real shipped
 * addon so an upgrade that changes that arithmetic fails loudly here rather
 * than silently re-wrapping every long line by one column.
 */

/**
 * Width (px) FitAddon holds back for the scrollbar when one can appear. This
 * is invisible but load-bearing: the app runs a non-zero scrollback and sets
 * no `scrollbar` option, so every fit gives the grid 14 fewer pixels than the
 * container and an off-by-one here wraps long lines a column early.
 */
export const DEFAULT_SCROLLBAR_WIDTH_PX = 14;

/** FitAddon refuses to propose narrower than this. */
export const MIN_COLS = 2;

/** FitAddon refuses to propose shorter than this. */
export const MIN_ROWS = 1;

/** A terminal cell's rendered size in CSS pixels. */
export interface CellSize {
  /** Cell width in CSS px. */
  width: number;
  /** Cell height in CSS px. */
  height: number;
}

/** A terminal grid. */
export interface Grid {
  /** Width in columns. */
  cols: number;
  /** Height in rows. */
  rows: number;
}

/** A box in CSS pixels. */
export interface Box {
  /** Width in CSS px. */
  width: number;
  /** Height in CSS px. */
  height: number;
}

/** Pixels a box loses before any cell is drawn. */
export interface BoxInsets {
  /** Horizontal padding total (left + right) on the terminal element. */
  padX: number;
  /** Vertical padding total (top + bottom) on the terminal element. */
  padY: number;
  /** Scrollbar reserve — see {@link scrollbarReserve}. */
  reserve: number;
}

/** The subset of terminal options that moves the scrollbar reserve. */
export interface ScrollbarOptions {
  /** Lines of scrollback; 0 means no scrollbar can ever appear. */
  scrollback?: number;
  /** Scrollbar overrides, matching xterm's `scrollbar` option. */
  scrollbar?: { showScrollbar?: boolean; width?: number };
}

/**
 * Pixels FitAddon holds back for the scrollbar, mirroring its own rule: a
 * reserve applies only when scrollback is non-zero AND the scrollbar is
 * shown.
 * @param options - The terminal's scrollback/scrollbar options
 * @returns The reserve in CSS px
 */
export function scrollbarReserve(options: ScrollbarOptions): number {
  const shown = options.scrollbar?.showScrollbar ?? true;
  if (options.scrollback === 0 || !shown) return 0;
  return options.scrollbar?.width ?? DEFAULT_SCROLLBAR_WIDTH_PX;
}

/**
 * The grid a box can display — what FitAddon would propose for it.
 *
 * Used as a CAPACITY report: the client tells the server the grid it could
 * show at the user's font size, and the server decides what the pane becomes.
 *
 * @param box - The measured container box in CSS px
 * @param cell - The rendered cell size in CSS px
 * @param insets - Padding and scrollbar reserve to subtract
 * @returns The grid, or null when the cell has not been measured yet
 */
export function gridForBox(box: Box, cell: CellSize, insets: BoxInsets): Grid | null {
  if (!(cell.width > 0) || !(cell.height > 0)) return null;
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null;
  const availableWidth = box.width - insets.padX - insets.reserve;
  const availableHeight = box.height - insets.padY;
  return {
    cols: Math.max(MIN_COLS, Math.floor(availableWidth / cell.width)),
    rows: Math.max(MIN_ROWS, Math.floor(availableHeight / cell.height)),
  };
}

/**
 * The box that makes {@link gridForBox} return exactly `grid` — the inverse,
 * and the size the terminal's container is pinned to so fitting is a no-op.
 *
 * Rounds the cell span UP because the browser reports a container's computed
 * width as a truncated integer: a fractional cell width would otherwise lose
 * the last column. The extra pixel cannot add a column, because it is smaller
 * than any real cell (glyphs are several px wide at every font size the app
 * offers), so the round trip is exact.
 *
 * @param grid - The authoritative grid to display
 * @param cell - The rendered cell size in CSS px
 * @param insets - Padding and scrollbar reserve to add back
 * @returns The container box in CSS px
 */
export function boxForGrid(grid: Grid, cell: CellSize, insets: BoxInsets): Box {
  return {
    width: Math.ceil(grid.cols * cell.width) + insets.padX + insets.reserve,
    height: Math.ceil(grid.rows * cell.height) + insets.padY,
  };
}

/**
 * True when `grid` cannot be shown in `box` at this cell size — the pane is
 * being asked to render a grid larger than the viewport, which happens when
 * another device is the size authority.
 *
 * @param grid - The authoritative grid
 * @param box - The available box in CSS px
 * @param cell - The rendered cell size in CSS px
 * @param insets - Padding and scrollbar reserve
 * @returns Whether the grid overflows the box
 */
export function gridOverflowsBox(grid: Grid, box: Box, cell: CellSize, insets: BoxInsets): boolean {
  const needed = boxForGrid(grid, cell, insets);
  return needed.width > box.width || needed.height > box.height;
}

/**
 * True when a grid is only FitAddon's degenerate FLOOR rather than a real
 * measurement.
 *
 * `gridForBox` mirrors FitAddon and clamps to 2x1, so a terminal measured
 * before its layout settles reports that instead of failing. Harmless while
 * one client owned its own size; with several viewers it is not, because the
 * pane is sized to the SMALLEST of them — one mid-layout device would drag
 * every other device's terminal down to a two-column strip. Observed live as
 * `ws attach … geometry 2x1`.
 *
 * The server refuses such a report as well (`resolveSharedGrid`); this stops
 * it being sent at all, which also keeps it out of the attach log.
 *
 * @param grid - A measured grid
 * @returns Whether it is too small to be a real viewport
 */
export function isDegenerateGrid(grid: Grid): boolean {
  return grid.cols <= MIN_COLS || grid.rows <= MIN_ROWS;
}

/**
 * The largest font size (px) at which `grid` still fits inside `box`.
 *
 * The shared pane is sized to the smallest viewer, so ordinarily every device
 * has room to spare and letterboxes. Not always: a viewer whose capacity was
 * REFUSED as degenerate takes no part in the decision, so the grid it is
 * handed can be larger than it can show — a phone in split view, a pane being
 * dragged narrow. Clipping there hides the prompt row, which is the one row
 * that matters, so the font shrinks to fit instead.
 *
 * Cell metrics scale linearly with font size, so the ratio that makes the
 * grid fit is the ratio to apply. Rounded DOWN to a whole pixel, because a
 * fractional size re-measures to a cell that may not fit.
 *
 * @param grid - The authoritative grid to display
 * @param box - The room available in CSS px
 * @param cell - The cell size at `fontSize`
 * @param insets - Padding and scrollbar reserve
 * @param fontSize - The font size `cell` was measured at
 * @returns A font size in px, never above `fontSize` and never below 1
 */
export function fontSizeToFit(grid: Grid, box: Box, cell: CellSize, insets: BoxInsets, fontSize: number): number {
  const needed = boxForGrid(grid, cell, insets);
  const widthRatio =
    (box.width - insets.padX - insets.reserve) / Math.max(1, needed.width - insets.padX - insets.reserve);
  const heightRatio = (box.height - insets.padY) / Math.max(1, needed.height - insets.padY);
  const ratio = Math.min(1, widthRatio, heightRatio);
  return Math.max(1, Math.floor(fontSize * ratio));
}
