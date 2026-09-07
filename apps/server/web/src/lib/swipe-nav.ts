/**
 * The pure half of prev/next swipe navigation (spec 2026-09-04): given a
 * finished drag's geometry, which neighbour does the user want — if any.
 * Lives on its own so the decision is unit-testable; the pointer plumbing
 * around it is `hooks/use-swipe-nav.ts`.
 */

/** `prev` = swipe right, `next` = swipe left (walking DOWN the sidebar list). */
export type SwipeIntent = "prev" | "next";

export interface SwipeIntentInput {
  /** Horizontal travel since gesture start, px (negative = finger moved left). */
  dx: number;
  /** Vertical travel since gesture start, px. */
  dy: number;
  /** Where the gesture started, viewport x px. */
  startX: number;
  /** Viewport width px at evaluation time. */
  viewportWidth: number;
}

/** Minimum horizontal travel (px) before a drag counts as a swipe. */
export const SWIPE_MIN_DX = 70;
/** How much more horizontal than vertical a drag must be (terminal scrollback is vertical). */
export const SWIPE_AXIS_RATIO = 1.3;
/** Strip at each viewport edge reserved for the browser/OS back gesture. */
export const SWIPE_EDGE_GUARD = 24;

/**
 * Decide the navigation intent of a finished horizontal drag.
 * @returns `next` for a committed left swipe, `prev` for a committed right
 * swipe, `null` for anything shorter, more vertical, or started in the edge guard.
 */
export function swipeIntent({ dx, dy, startX, viewportWidth }: SwipeIntentInput): SwipeIntent | null {
  if (startX < SWIPE_EDGE_GUARD || viewportWidth - startX < SWIPE_EDGE_GUARD) return null;
  if (Math.abs(dx) < SWIPE_MIN_DX) return null;
  if (Math.abs(dx) <= Math.abs(dy) * SWIPE_AXIS_RATIO) return null;
  return dx < 0 ? "next" : "prev";
}
