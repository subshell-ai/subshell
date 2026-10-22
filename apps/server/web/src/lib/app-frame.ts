import { isDetailPath } from "@/lib/route-ids";

/**
 * Which pages OWN the bottom edge of the frame on touch.
 *
 * The shell pads the home-indicator strip for the pages that SCROLL — their
 * last row must clear it. But these pages never scroll, and they pad that
 * strip themselves, in the colour of their own bottom surface:
 *
 * - `/subshells/$id` — the touch key bar owns a compact 4px bottom gutter
 *   inside its own bg-card strip (see `terminal-key-bar.tsx`).
 * - `/workspaces/$id` — the dock's active pane shows that same
 *   key bar (it is gated on `coarse`); the phone's tabs presentation
 *   (`useIsPhoneLayout`) also shows the selected pane's key bar.
 *   Only an empty phone workspace pads its terminal column with the full
 *   inset, since it has no pane to provide that clearance.
 *
 * Stacking the shell's pad on top of either owner used to render a
 * background band (34 pt on a notched iPhone — half of the short-height
 * report; the other half was the standalone `dvh` bug, fixed in
 * `use-visual-viewport-insets`). So the shell stands down wherever a page
 * owns its bottom edge — and each owner must keep its own pad, or the last
 * terminal row sits under the home indicator.
 *
 * Pure and exported so the rule is testable without mounting the shell.
 * The id segment is what makes it the DETAIL pages: `/subshells` and
 * `/workspaces` (no id) are the list pages, which scroll.
 */
export function routeOwnsBottomEdge(pathname: string): boolean {
  return isDetailPath(pathname);
}
