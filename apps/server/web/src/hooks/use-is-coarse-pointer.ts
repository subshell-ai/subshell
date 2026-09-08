import { useEffect, useState } from "react";

/**
 * True on touch-primary pointers (phones, tablets with a finger). Mirrors
 * `useIsWide()`'s matchMedia plumbing. A desktop with a touchscreen reports
 * `fine` (pointer: fine reflects the PRIMARY pointer), which is what we want:
 * the mouse-driven chrome stays.
 */
export function useIsCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mql.addEventListener("change", onChange);
    setCoarse(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return coarse;
}
