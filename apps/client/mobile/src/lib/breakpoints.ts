/**
 * The one layout breakpoint, mirroring `WORKSPACE_TILING_MIN_WIDTH` in
 * `apps/server/web/src/lib/breakpoints.ts`.
 *
 * The web app flips sidebar↔drawer and dock↔tabs on this single number, and the
 * mobile spec inherited it rather than inventing a second rule. The consequence
 * is deliberate: **iPad portrait (834px) is compact**, landscape (1194px) is not.
 *
 * React Native has no size classes, so callers feed it
 * `useWindowDimensions().width`, which also re-renders under iPad Split View.
 *
 * Duplicated on purpose for now (two apps, no shared UI package). If a third
 * consumer appears — or the key-bar byte table gets promoted alongside it — move
 * this into a package rather than letting three copies drift.
 */
export const WIDE_MIN_WIDTH = 1024;

/** True when the window should get the desktop-shaped (sidebar) shell. */
export function isWide(widthPx: number): boolean {
  return widthPx >= WIDE_MIN_WIDTH;
}

/** The ratified target widths, kept next to the rule they exercise. */
export const TARGET_WIDTHS = {
  /** iPhone 15 Pro, portrait. */
  phonePortrait: 393,
  /** iPad Pro 11", portrait — compact by the inherited rule. */
  ipadPortrait: 834,
  /** iPad Pro 11", landscape — the only compact→wide flip in the matrix. */
  ipadLandscape: 1194,
} as const;
