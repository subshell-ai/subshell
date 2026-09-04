/**
 * Deciding one pane grid for several viewers.
 *
 * A tmux pane has exactly ONE grid, so the moment two devices watch the same
 * subshell the server has to choose. It used to dodge the question by evicting
 * the older viewer (close 4003), because letting two differently sized clients
 * each assert their own size made the pane bounce between them and shattered
 * every relative-positioned redraw.
 *
 * The default rule is SMALLEST-WINS: the pane is sized so that every viewer
 * can display all of it. A viewer larger than the pane letterboxes the grid
 * (it has spare room, so nothing is lost); a viewer smaller than the pane
 * would have to clip, and clipped rows are content the user cannot see. This
 * is also tmux's own answer for multiple attached clients.
 *
 * The important property is not which extreme is chosen but that the answer is
 * a PURE FUNCTION of the viewer set: the same viewers always produce the same
 * grid, in any order, so the pane cannot oscillate. Last-writer-wins had no
 * such property, which is what made two viewers unusable.
 *
 * Two things override the plain minimum, and both exist because "smallest
 * wins" is the wrong answer when the smallest viewer is not really watching:
 *
 * - HIDDEN viewers are ignored. A backgrounded tab reports `hidden`, and a
 *   browser stops laying it out entirely — no `requestAnimationFrame`, no
 *   `ResizeObserver` — so it cannot even re-fit until it is shown again.
 *   Letting it hold everyone else's pane at phone size, with no visible
 *   reason, is the worst kind of spooky action; it rejoins the decision the
 *   moment it is looked at.
 * - A PINNED viewer decides alone. Ignoring hidden viewers is a good default
 *   but it is still a guess about intent; pinning is the operator saying which
 *   screen matters, and it beats the guess.
 */

/** A terminal grid. */
export interface Grid {
  /** Width in columns. */
  cols: number;
  /** Height in rows. */
  rows: number;
}

/** One viewer's input to the decision. */
export interface ViewerCapacity {
  /** Identifies the viewer; matches a pin. */
  id: string;
  /** The grid it says it can display, or null before it has said. */
  capacity: Grid | null;
  /** True while the viewer's page is not being rendered at all. */
  hidden?: boolean;
}

/** How a subshell's grid is being decided. */
export type SizingMode = "auto" | "pinned";

/** The operator's choice for one subshell. */
export interface SizingPolicy {
  /** `auto` = smallest visible viewer; `pinned` = one named viewer decides. */
  mode: SizingMode;
  /** Which viewer decides under `pinned`; ignored under `auto`. */
  pinnedViewerId?: string | null;
}

/** The policy a subshell has until anyone changes it. */
export const DEFAULT_SIZING: SizingPolicy = { mode: "auto", pinnedViewerId: null };

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

/** True when a reported capacity is big enough to size a shared pane by. */
function isUsable(grid: Grid): boolean {
  return grid.cols >= MIN_SHARED_COLS && grid.rows >= MIN_SHARED_ROWS;
}

/** True when a capacity is a real, positive, integral grid. */
function isWellFormed(grid: Grid | null): grid is Grid {
  return grid !== null && Number.isInteger(grid.cols) && Number.isInteger(grid.rows) && grid.cols > 0 && grid.rows > 0;
}

/** Per-axis minimum over a non-empty list. */
function smallest(grids: readonly Grid[]): Grid {
  return grids.reduce((min, c) => ({ cols: Math.min(min.cols, c.cols), rows: Math.min(min.rows, c.rows) }));
}

/** Per-axis maximum over a non-empty list. */
function largest(grids: readonly Grid[]): Grid {
  return grids.reduce((max, c) => ({ cols: Math.max(max.cols, c.cols), rows: Math.max(max.rows, c.rows) }));
}

/**
 * The grid a pane should take, given what each attached viewer can display
 * and the operator's sizing policy.
 *
 * Independent per axis: a short wide phone and a tall narrow one together
 * yield the narrow width and the short height, so both see everything.
 *
 * @param viewers - Every attached viewer, in any order
 * @param policy - The sizing choice; defaults to smallest-visible-wins
 * @returns The grid to apply, or null when there is nothing to size for
 */
export function resolveSharedGrid(
  viewers: readonly ViewerCapacity[],
  policy: SizingPolicy = DEFAULT_SIZING,
): Grid | null {
  const valid = viewers.filter((v) => isWellFormed(v.capacity)) as Array<ViewerCapacity & { capacity: Grid }>;
  if (valid.length === 0) return null;

  // A pin is the operator naming the screen that matters, so it outranks
  // everything below — including the hidden rule, because a deliberately
  // pinned device should not lose the pane merely by being backgrounded.
  if (policy.mode === "pinned" && policy.pinnedViewerId) {
    const pinned = valid.find((v) => v.id === policy.pinnedViewerId);
    if (pinned) return pinned.capacity;
    // The pinned device is gone (closed, reconnected under a new id). Fall
    // through to auto rather than freezing the pane at a departed viewer's
    // size; the caller clears the stale pin when it notices.
  }

  // Prefer the viewers actually being rendered. If every one is hidden, they
  // all count again — something has to size the pane, and the last thing the
  // user looked at is a better answer than an arbitrary default.
  const visible = valid.filter((v) => !v.hidden);
  const considered = visible.length > 0 ? visible : valid;

  const usable = considered.filter((v) => isUsable(v.capacity)).map((v) => v.capacity);
  if (usable.length > 0) return smallest(usable);

  // Every considered viewer is mid-layout. Sizing to the smallest of a set of
  // degenerate reports would paint into a 2x1 strip, so take the LARGEST
  // instead — it is the closest thing to a real viewport on offer, and the
  // next report from any settled viewer supersedes it.
  return largest(considered.map((v) => v.capacity));
}
