import { useEffect, useState } from "react";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { isKeyboardUp } from "@/lib/app-scroll-pin";

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
    const update = () => {
      const raw = computeInsets(vv);
      // Apply the pin ONLY while the keyboard genuinely covers the viewport
      // or the page is panned. With the keyboard closed, fall back to the
      // CSS h-dvh full-height frame: iOS visualViewport can report a height
      // short by toolbar chrome even with no keyboard, and applying that to
      // the shell left a dead black band under the key bar (the "view does
      // not use the full height" report). Residual pans keep the pin until
      // the scroll pin (subshell-terminal) zeroes them, after which this
      // flips back to full height.
      const active = isKeyboardUp(vv.height, window.innerHeight) || raw.offsetYpx > 0;
      setInsets(active ? raw : null);
    };
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
