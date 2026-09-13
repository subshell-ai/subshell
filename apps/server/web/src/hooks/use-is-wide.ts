import { useMinWidth } from "@/hooks/use-min-width";
import { WORKSPACE_TILING_MIN_WIDTH } from "@/lib/breakpoints";

/**
 * True when the viewport is wide enough to tile (see
 * {@link WORKSPACE_TILING_MIN_WIDTH}).
 *
 * This is the TILING question only. Whether the shell shows its sidebar is
 * `useHasSidebar`, which crosses a much lower breakpoint — the two were one
 * hook, and that is what tied the navigation to a workspace's column budget.
 */
export function useIsWide(): boolean {
  return useMinWidth(WORKSPACE_TILING_MIN_WIDTH);
}
