/**
 * Which pages OWN the bottom edge of the frame on touch.
 *
 * The shell pads the home-indicator strip for the pages that SCROLL — their
 * last row must clear it. But these pages never scroll, and they pad that
 * strip themselves, in the colour of their own bottom surface:
 *
 * - `/subshells/$id` — the touch key bar pads inside its own bg-card strip.
 * - `/workspaces/$id` — the WIDE dock's active pane shows that same key bar;
 *   the narrow tabs presentation (every phone-portrait visit — the dock is
 *   `useIsWide()`) carries no key bar and pads its terminal column instead,
 *   in `bg-terminal-canvas`.
 *
 * Both paddings on one of these pages stack into a background band under
 * the bar (34 pt on a notched iPhone — half of the short-height report; the
 * other half is the standalone `dvh` bug, fixed in
 * `use-visual-viewport-insets`). So the shell stands down wherever a page
 * owns its bottom edge — and each owner must keep its own pad, or the last
 * terminal row sits under the home indicator.
 *
 * Pure and exported so the rule is testable without mounting the shell.
 * The id segment is what makes it the DETAIL pages: `/subshells` and
 * `/workspaces` (no id) are the list pages, which scroll.
 */
export function routeOwnsBottomEdge(pathname: string): boolean {
  return /^\/(subshells|workspaces)\/[^/]+/.test(pathname);
}
