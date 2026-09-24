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
 * The pure decision behind the pin, exported for unit tests.
 *
 * Keyboard up (or a residual pan): shrink to the visible viewport and ride
 * the pan — that is what keeps the key bar above the keyboard.
 *
 * Otherwise it depends on the display mode, and the two answers exist
 * because the two failure modes are opposite:
 *
 * - **Standalone home-screen install:** pin to `window.innerHeight`. iOS
 *   computes `dvh`/`svh`/`lvh` in a standalone web app as if Safari's
 *   collapsed bottom toolbar still existed, so the CSS fallback frame ends
 *   ~64 px short on cold start and only corrects itself after a rotation —
 *   the dead band under the key bar in the PWA-height report. `innerHeight`
 *   is not derived from that computation: on the WKWebView it IS the window.
 *   It also sidesteps the older cut of the same bug, where pinning to
 *   `visualViewport.height` with the keyboard down reproduced the band
 *   because that reading is chrome-reduced too.
 * - **Browser tab:** null, so the CSS `h-dvh` answers. There the toolbar
 *   choreography is real and `dvh` tracks it live; a fixed `innerHeight` px
 *   would re-introduce a band every time the toolbar collapses.
 */
export function decideFramePin(args: {
  vv: { height: number; offsetTop: number } | null;
  innerHeight: number;
  standalone: boolean;
}): VisualViewportInsets | null {
  if (!args.vv) return null;
  const raw = computeInsets(args.vv);
  if (isKeyboardUp(args.vv.height, args.innerHeight) || raw.offsetYpx > 0) return raw;
  if (args.standalone) return { heightPx: Math.max(0, Math.round(args.innerHeight)), offsetYpx: 0 };
  return null;
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
    // Fixed for the life of the document: a tab does not become a
    // home-screen install while open. `display-mode` is the standard query
    // (Chrome, iOS 15.4+); `navigator.standalone` is the older iOS spelling.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    const update = () => setInsets(decideFramePin({ vv, innerHeight: window.innerHeight, standalone }));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    // The standalone pin reads `window.innerHeight`, which only the WINDOW's
    // own resize can change (rotation) — no visualViewport event is
    // guaranteed to accompany it.
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [coarse]);

  return insets;
}
