import { useEffect, useState } from "react";
import { WORKSPACE_TILING_MIN_WIDTH } from "@/lib/breakpoints";

/**
 * True when the viewport is wide enough to tile (see
 * {@link WORKSPACE_TILING_MIN_WIDTH}). Updates on resize and orientation
 * change, so rotating a tablet switches presentation.
 */
export function useIsWide(): boolean {
  const query = `(min-width: ${WORKSPACE_TILING_MIN_WIDTH}px)`;
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.matchMedia(query).matches));

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mql.addEventListener("change", onChange);
    setWide(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return wide;
}
