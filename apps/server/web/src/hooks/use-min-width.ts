import { useEffect, useState } from "react";

/**
 * True while the viewport is at least `px` wide. Updates on resize and
 * orientation change, so rotating a tablet switches presentation.
 *
 * The shared matchMedia plumbing behind every width breakpoint in the app —
 * `useIsWide` and `useHasSidebar` differ only in the number they pass.
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
