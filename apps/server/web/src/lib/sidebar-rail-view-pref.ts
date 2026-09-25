/**
 * How this device renders the rail's subshell section — rows, grouped status
 * cells, or one flat cell grid.
 *
 * A per-DEVICE preference, the same tier as `sidebar-node-group-pref`: which
 * shape you want the list in is a property of the screen you are at (a narrow
 * laptop rail favours cells, a wide desktop rail reads rows fine), not of the
 * account. It is deliberately NOT keyed to anything server-side: the mode is
 * a rendering choice over data every viewer already shares.
 *
 * Every access is try/catch'd — private-mode Safari throws on `localStorage`
 * outright, and a rail that cannot render because it could not read a
 * cosmetic preference is worse than a rail that forgets one. A value that is
 * not one of the known modes (corrupt, hand-edited, or written by a future
 * build with more modes) reads as `rows`: the shape the rail has always had
 * is the shape a broken preference should fall back to.
 */

/** One of the rail's subshell rendering modes. */
export type RailSubshellsView = "rows" | "cells" | "cells-flat";

/**
 * Every mode, in control order. The Segmented renders its options from a
 * table keyed off this, and the reader validates against it, so adding a
 * mode is one edit here plus its option — the storage guard cannot drift
 * from the list it guards.
 */
export const RAIL_SUBSHELLS_VIEWS: readonly RailSubshellsView[] = ["rows", "cells", "cells-flat"];

/** localStorage key holding this device's mode. */
const KEY = "subshell.sidebarRailView";

/** The stored mode, or `rows` for absent / unknown / blocked storage. */
export function railSubshellsView(): RailSubshellsView {
  try {
    const raw = localStorage.getItem(KEY);
    return RAIL_SUBSHELLS_VIEWS.includes(raw as RailSubshellsView) ? (raw as RailSubshellsView) : "rows";
  } catch {
    return "rows";
  }
}

/**
 * Persists one mode.
 * @returns the value stored, so callers bind their render to the stored fact
 *          rather than to what they intended to store
 */
export function setRailSubshellsView(view: RailSubshellsView): RailSubshellsView {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // Storage refused: the choice still holds for this page load, which is
    // the part the user is looking at.
  }
  return view;
}
