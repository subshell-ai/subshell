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
