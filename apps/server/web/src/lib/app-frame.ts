/**
 * Which pages OWN the bottom edge of the frame on touch.
 *
 * The shell pads the home-indicator strip for the pages that SCROLL — their
 * last row must clear it. But the terminal and workspace pages never scroll:
 * their bottom-most element is the key bar, and that bar pads the safe area
 * INSIDE its own bg-card strip so the card reaches the physical bottom of
 * the screen. Both paddings on one of these pages stack into a background
 * band under the bar (34 pt on a notched iPhone — half of the short-height
 * report; the other half is the standalone `dvh` bug, fixed in
 * `use-visual-viewport-insets`). So the shell stands down wherever a page
 * owns its bottom edge.
 *
 * Pure and exported so the rule is testable without mounting the shell.
 * The id segment is what makes it the DETAIL pages: `/subshells` and
 * `/workspaces` (no id) are the list pages, which scroll.
 */
export function routeOwnsBottomEdge(pathname: string): boolean {
  return /^\/(subshells|workspaces)\/[^/]+/.test(pathname);
}
