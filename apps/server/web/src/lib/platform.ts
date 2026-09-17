/**
 * Which kind of device is reading this page.
 *
 * Deliberately User-Agent sniffing, which is normally the wrong tool: what
 * both callers need is not a capability they could feature-detect but WHICH
 * SET OF WORDS to put on screen — "Share → Add to Home Screen" is a sentence
 * about Safari's chrome, and no API reports the shape of a browser's menus.
 *
 * Both functions take their inputs as arguments so the rules are testable
 * without stubbing globals, and default to the real ones for callers in
 * render.
 */

/** Safari on iOS/iPadOS — the only browser there, and the one whose install
 * step is a share sheet. */
export function isIOS(
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  // `?? 0` is not belt and braces: a default parameter applies only to a
  // MISSING argument, and this expression can itself evaluate to undefined
  // (an old WebView, a test DOM) while its type says `number` — so the
  // coalesce is what makes the annotation true.
  touchPoints: number = typeof navigator === "undefined" ? 0 : (navigator.maxTouchPoints ?? 0),
): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ requests desktop sites by default, so an iPad's Safari calls
  // itself a Macintosh. Touch points are the tell: no Mac reports any, and an
  // iPad handed the desktop instructions is handed steps its browser has not
  // got.
  return /Macintosh/.test(ua) && touchPoints > 0;
}

/** Android, where the install lives in the browser's own overflow menu. */
export function isAndroid(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /Android/.test(ua);
}
