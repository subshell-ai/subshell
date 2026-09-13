import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { useMinWidth } from "@/hooks/use-min-width";
import { SIDEBAR_MIN_WIDTH, WORKSPACE_TILING_MIN_WIDTH } from "@/lib/breakpoints";

/**
 * True when the shell shows its persistent sidebar rather than the hamburger
 * drawer. One predicate, because the sidebar and the drawer's trigger must
 * never both be on screen and never both be absent.
 *
 * Two rules, and the pointer is what separates them — the same split
 * `useIsStackedHeader` makes, for the same reason:
 *
 * - A mouse-driven window shows the rail from {@link SIDEBAR_MIN_WIDTH}, so a
 *   narrow desktop window keeps its navigation instead of paying for phone
 *   chrome it has no use for.
 * - A touch-primary device keeps the drawer until
 *   {@link WORKSPACE_TILING_MIN_WIDTH}, unchanged. A phone is ~390 CSS pixels
 *   wide; a 240px rail there would leave a strip of content, and the drawer is
 *   the right chrome for a finger anyway.
 */
export function useHasSidebar(): boolean {
  const coarse = useIsCoarsePointer();
  const overSidebarWidth = useMinWidth(SIDEBAR_MIN_WIDTH);
  const overTilingWidth = useMinWidth(WORKSPACE_TILING_MIN_WIDTH);
  return coarse ? overTilingWidth : overSidebarWidth;
}
