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

/** A viewer that has reported a real, positive, integral grid. */
type SizedViewer = ViewerCapacity & { capacity: Grid };

/**
 * True when a viewer has reported a capacity worth considering at all.
 *
 * A narrowing predicate rather than a filter+cast: the cast is what let a
 * `capacity: null` reach the reducers as `{cols: undefined}` in an earlier
 * shape of this code, and NaN propagates silently through Math.min.
 */
function isSized(viewer: ViewerCapacity): viewer is SizedViewer {
  const g = viewer.capacity;
  return g !== null && Number.isInteger(g.cols) && Number.isInteger(g.rows) && g.cols > 0 && g.rows > 0;
}

/**
 * The axis extremes of a non-empty viewer list, with attribution: which
 * viewers actually hold each axis where it is. Attribution is what lets a UI
 * answer "why is my terminal only 80 columns wide" by naming the device.
 *
 * @param viewers - Non-empty list of viewers with well-formed capacities
 * @param pick - `min` for smallest-wins, `max` for the degenerate fallback
 * @returns The extreme grid and the ids holding each axis
 */
function extremeOf(
  viewers: readonly SizedViewer[],
  pick: "min" | "max",
): { grid: Grid; cols: string[]; rows: string[] } {
  const better = (a: number, b: number) => (pick === "min" ? Math.min(a, b) : Math.max(a, b));
  const grid = viewers.reduce<Grid>(
    (acc, v) => ({ cols: better(acc.cols, v.capacity.cols), rows: better(acc.rows, v.capacity.rows) }),
    { cols: viewers[0].capacity.cols, rows: viewers[0].capacity.rows },
  );
  return {
    grid,
    cols: viewers.filter((v) => v.capacity.cols === grid.cols).map((v) => v.id),
    rows: viewers.filter((v) => v.capacity.rows === grid.rows).map((v) => v.id),
  };
}

/** How a grid was arrived at — see {@link GridDecision}. */
export type GridReason = "pinned" | "smallest" | "fallback";

/**
 * The grid a pane takes AND why, so the answer can be shown rather than
 * merely obeyed.
 *
 * The "why" is not decoration. Smallest-wins means one device silently
 * shrinks everyone else's terminal, and a user staring at an 80-column pane
 * on a 4K monitor has no way to discover that a phone in another room is the
 * reason. `cols`/`rows` name the devices actually holding each axis.
 */
export interface GridDecision {
  /** The grid to apply. */
  grid: Grid;
  /** Ids of the viewers whose capacity holds the width where it is. */
  cols: readonly string[];
  /** Ids of the viewers whose capacity holds the height where it is. */
  rows: readonly string[];
  /** Which rule produced the grid. */
  reason: GridReason;
}

/**
 * The grid a pane should take, given what each attached viewer can display
 * and the operator's sizing policy — with the reasoning attached.
 *
 * Independent per axis: a short wide phone and a tall narrow one together
 * yield the narrow width and the short height, so both see everything, and
 * `cols`/`rows` then name different devices.
 *
 * @param viewers - Every attached viewer, in any order
 * @param policy - The sizing choice; defaults to smallest-visible-wins
 * @returns The decision, or null when there is nothing to size for
 */
export function decideSharedGrid(
  viewers: readonly ViewerCapacity[],
  policy: SizingPolicy = DEFAULT_SIZING,
): GridDecision | null {
  const valid = viewers.filter(isSized);
  if (valid.length === 0) return null;

  // A pin is the operator naming the screen that matters, so it outranks
  // everything below — including the hidden rule, because a deliberately
  // pinned device should not lose the pane merely by being backgrounded.
  if (policy.mode === "pinned" && policy.pinnedViewerId) {
    const pinned = valid.find((v) => v.id === policy.pinnedViewerId);
    if (pinned) return { grid: pinned.capacity, cols: [pinned.id], rows: [pinned.id], reason: "pinned" };
    // The pinned device is gone (closed, reconnected under a new id). Fall
    // through to auto rather than freezing the pane at a departed viewer's
    // size; the caller clears the stale pin when it notices.
  }

  // Prefer the viewers actually being rendered. If every one is hidden, they
  // all count again — something has to size the pane, and the last thing the
  // user looked at is a better answer than an arbitrary default.
  const visible = valid.filter((v) => !v.hidden);
  const considered = visible.length > 0 ? visible : valid;

  const usable = considered.filter((v) => isUsable(v.capacity));
  if (usable.length > 0) return { ...extremeOf(usable, "min"), reason: "smallest" };

  // Every considered viewer is mid-layout. Sizing to the smallest of a set of
  // degenerate reports would paint into a 2x1 strip, so take the LARGEST
  // instead — it is the closest thing to a real viewport on offer, and the
  // next report from any settled viewer supersedes it.
  return { ...extremeOf(considered, "max"), reason: "fallback" };
}

/**
 * {@link decideSharedGrid} without the reasoning — what a caller that only
 * has to APPLY the grid wants.
 *
 * @param viewers - Every attached viewer, in any order
 * @param policy - The sizing choice; defaults to smallest-visible-wins
 * @returns The grid to apply, or null when there is nothing to size for
 */
export function resolveSharedGrid(
  viewers: readonly ViewerCapacity[],
  policy: SizingPolicy = DEFAULT_SIZING,
): Grid | null {
  return decideSharedGrid(viewers, policy)?.grid ?? null;
}
