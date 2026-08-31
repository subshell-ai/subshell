import { useEffect, useState } from "react";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";

/** What a full-height mobile surface must size/shift to stay above the soft
 * keyboard: the visible viewport never changes the layout viewport on iOS,
 * only `visualViewport` does. */
export interface VisualViewportInsets {
  /** Visible height in px (soft keyboard subtracted). */
  heightPx: number;
  /** Downward pan (px) iOS applies to the layout viewport when an input is
   * focused; a full-height shell translates by it to stay glued to the top
   * of the visible viewport. */
  offsetYpx: number;
}

/** Pure math, exported for unit tests. */
export function computeInsets(vv: { height: number; offsetTop: number }): VisualViewportInsets {
  return {
    heightPx: Math.max(0, Math.round(vv.height)),
    offsetYpx: Math.max(0, vv.offsetTop),
  };
}

/**
 * Tracks `window.visualViewport` on coarse-pointer devices and returns the
 * insets a full-height page should apply; null everywhere else (desktop,
 * browsers without the API) so callers fall back to their CSS `h-dvh`.
 */
export function useVisualViewportInsets(): VisualViewportInsets | null {
  const coarse = useIsCoarsePointer();
  const [insets, setInsets] = useState<VisualViewportInsets | null>(null);

  useEffect(() => {
    const vv = coarse ? window.visualViewport : null;
    if (!vv) {
      setInsets(null);
      return;
    }
    const update = () => setInsets(computeInsets(vv));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [coarse]);

  return insets;
}
