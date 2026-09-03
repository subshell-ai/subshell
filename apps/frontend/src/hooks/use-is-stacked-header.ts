import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { useIsWide } from "@/hooks/use-is-wide";

/**
 * True when a detail header must reflow to stacked rows (chrome row on top,
 * title + subtitle under it): below the tiling width AND on a touch-primary
 * pointer.
 *
 * Width alone used to drive the reflow, which made a small desktop window —
 * HiDPI scaling easily puts a maximised window under the tiling breakpoint
 * in CSS pixels — pay the phone layout, burning a second row on the title
 * despite having the mouse and the horizontal room for the inline one. The
 * pointer is what separates those windows from a phone: `fine` keeps the
 * single-row header at any width; a coarse (finger) pointer below the tiling
 * width still stacks, where title + path genuinely do not share a line.
 */
export function useIsStackedHeader(): boolean {
  const wide = useIsWide();
  const coarse = useIsCoarsePointer();
  return !wide && coarse;
}
