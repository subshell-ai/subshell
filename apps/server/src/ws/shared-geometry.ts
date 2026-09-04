/**
 * Deciding one pane grid for several viewers.
 *
 * A tmux pane has exactly ONE grid, so the moment two devices watch the same
 * subshell the server has to choose. Until now it dodged the question by
 * evicting the older viewer (close 4003), because letting two differently
 * sized clients each assert their own size made the pane bounce between them
 * and shattered every relative-positioned redraw.
 *
 * The rule here is SMALLEST-WINS: the pane is sized so that every viewer can
 * display all of it. A viewer larger than the pane letterboxes the grid (it
 * has spare room, so nothing is lost); a viewer smaller than the pane would
 * have to clip, and clipped rows are content the user simply cannot see.
 * This is also tmux's own answer for multiple attached clients.
 *
 * The important property is not which extreme is chosen but that the answer
 * is a PURE FUNCTION of the viewer set: the same viewers always produce the
 * same grid, in any order, so the pane cannot oscillate. Last-writer-wins had
 * no such property, which is what made two viewers unusable.
 */

/** A terminal grid. */
export interface Grid {
  /** Width in columns. */
  cols: number;
  /** Height in rows. */
  rows: number;
}

/**
 * Narrowest grid worth sharing. FitAddon clamps a degenerate box to its own
 * 2x1 floor, and a client that measures mid-layout — a pane being dragged, a
 * tab mounting, a phone rotating — really does report it (observed live:
 * `ws attach … geometry 2x1`). One such report must not drag every other
 * device's pane down to a two-column strip, so a capacity below this is
 * ignored while any usable one exists.
 */
export const MIN_SHARED_COLS = 20;

/** Shortest grid worth sharing — see {@link MIN_SHARED_COLS}. */
export const MIN_SHARED_ROWS = 5;

/** The size a pane falls back to when nothing usable was reported. */
export const DEFAULT_GRID: Grid = { cols: 80, rows: 24 };

/**
 * True when a reported capacity is big enough to size a shared pane by.
 * @param grid - A viewer's reported capacity
 * @returns Whether it should participate in the minimum
 */
function isUsable(grid: Grid): boolean {
  return grid.cols >= MIN_SHARED_COLS && grid.rows >= MIN_SHARED_ROWS;
}

/**
 * The grid a pane should take, given what each attached viewer can display.
 *
 * Independent per axis: a short wide phone and a tall narrow one together
 * yield the narrow width and the short height, so both see everything.
 *
 * @param capacities - Each viewer's reported capacity, in any order
 * @returns The grid to apply, or null when there is nothing to size for
 */
export function resolveSharedGrid(capacities: readonly Grid[]): Grid | null {
  const valid = capacities.filter(
    (c) => Number.isInteger(c.cols) && Number.isInteger(c.rows) && c.cols > 0 && c.rows > 0,
  );
  if (valid.length === 0) return null;

  const usable = valid.filter(isUsable);
  if (usable.length === 0) {
    // Every viewer is mid-layout. Sizing to the smallest of a set of
    // degenerate reports would paint into a 2x1 strip, so take the LARGEST
    // instead — it is the closest thing to a real viewport on offer, and the
    // next report from any settled viewer supersedes it.
    return valid.reduce<Grid>((best, c) => ({ cols: Math.max(best.cols, c.cols), rows: Math.max(best.rows, c.rows) }), {
      cols: 0,
      rows: 0,
    });
  }

  return usable.reduce<Grid>((min, c) => ({ cols: Math.min(min.cols, c.cols), rows: Math.min(min.rows, c.rows) }), {
    cols: Number.POSITIVE_INFINITY,
    rows: Number.POSITIVE_INFINITY,
  });
}
