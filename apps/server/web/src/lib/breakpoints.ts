/**
 * Minimum viewport width, in pixels, at which a workspace tiles.
 *
 * Below this the workspace renders as tabs instead: 80 columns at the app's
 * 13px terminal font is roughly 640px, so a phone cannot usefully tile
 * terminals and a portrait tablet gives neither pane enough room to read.
 *
 * Both presentations import this constant so they cannot disagree about which
 * one is active.
 */
export const WORKSPACE_TILING_MIN_WIDTH = 1024;

/**
 * Minimum viewport width, in pixels, at which the persistent sidebar replaces
 * the hamburger drawer.
 *
 * Two thirds of {@link WORKSPACE_TILING_MIN_WIDTH}, and deliberately not the
 * same number: tiling needs room for two 80-column terminals, but a nav rail
 * needs room for a nav rail plus a page worth reading. Sharing the tiling
 * width meant a window had to be wide enough for a SPLIT WORKSPACE before it
 * was allowed to show its own navigation.
 *
 * The floor is where the 240px rail stops paying for itself: at 683 it leaves
 * 443px of content, and below that it is taking more than a third of the
 * window to say where you are. That is why this is not lower still — the
 * desktop apps can be dragged down to 360, and there the drawer is right.
 *
 * Width alone does not decide it — see `useHasSidebar`, which keeps a phone on
 * the drawer at any width.
 */
export const SIDEBAR_MIN_WIDTH = 683;
