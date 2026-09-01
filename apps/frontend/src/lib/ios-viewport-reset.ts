/**
 * Heal the iOS standalone-webapp viewport after WebKit's auto-zoom has
 * poisoned it. Focusing an input under 16px makes WebKit zoom the page
 * (~16/font-size), and in home-screen PWAs the zoom — and the keyboard-
 * shrunk layout height it rides on — can PERSIST across app kills: the
 * next launch boots at `visualViewport.scale ≈ 1.15` with `innerHeight`
 * stuck ~160pt short, leaving a dead black band no CSS can reach (the
 * webview itself is the broken box).
 *
 * There is no setter for the scale, but WebKit recomputes viewport metrics
 * whenever the `<meta viewport>` content changes: briefly forbidding zoom
 * clamps the live scale back to 1 and forces the re-layout; restoring the
 * original content immediately after puts user zooming back on the table.
 * Scoped to standalone mode so a deliberate pinch-zoom in Safari browser is
 * never yanked away.
 */
export function isStandalone(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(display-mode: standalone)").matches;
}

/**
 * Reset the zoom if it is stuck above ~1 in a standalone launch.
 * @param scale the current `visualViewport.scale`
 * @returns whether a reset was issued (useful for callers/tests)
 */
export function maybeResetViewport(scale: number): boolean {
  if (!isStandalone() || scale <= 1.02) return false;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return false;
  const original = meta.getAttribute("content") ?? "";
  meta.setAttribute("content", `${original}, maximum-scale=1`);
  requestAnimationFrame(() => meta.setAttribute("content", original));
  return true;
}
