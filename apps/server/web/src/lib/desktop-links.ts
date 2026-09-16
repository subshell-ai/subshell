import { isDesktop } from "@/lib/desktop";

/**
 * External links inside a desktop shell's window.
 *
 * A `target="_blank"` anchor is dead in a Tauri webview — measured, not
 * inferred, on 2026-09-16 with both callbacks instrumented: the page receives
 * the click on the anchor, and the webview then raises NOTHING at the app.
 * Neither the navigation delegate nor the new-window delegate is consulted,
 * so there is no handler the native side could write to catch it. A
 * `window.open` from the same page under the same click DOES reach the
 * app's `on_new_window` handler, which hands http(s) to the system browser
 * and denies everything else — the route this module sends links through.
 *
 * So when the page runs inside Subshell Server's or Subshell Client's window,
 * every external blank-target link is answered in the capture phase here.
 * The native handler remains the security boundary: it re-checks the scheme,
 * and this module is only why it gets asked.
 *
 * Mounted from `main.tsx`, NOT from a component: the listener outlives
 * every mount and unmount, and it is armed once per document. The real
 * `console` and `window.open` never fire under bun's DOM, so tests drive
 * `desktopLinkClick` directly — see `__tests__/desktop-links.test.ts`.
 */
export function installDesktopLinkHandling(): () => void {
  if (!isDesktop()) return () => {};
  document.addEventListener("click", onDocClick, true);
  return () => document.removeEventListener("click", onDocClick, true);
}

function onDocClick(event: MouseEvent): void {
  if (!desktopLinkClick(event, (url) => window.open(url, "_blank", "noopener"))) return;
}

/**
 * The decision, apart from the DOM: returns whether it acted.
 *
 * Left button, no modifiers — a cmd-click's "open in new tab" is the browser
 * asking, and a webview has no tabs to offer, so let WebKit's own (inert)
 * path keep it. Only `http(s):` qualifies: `mailto:` and friends are for the
 * OS handler, which nothing here may invoke from a page, and `javascript:`
 * is exactly what the native gate would refuse anyway. `noopener` is set
 * because the opened window must not gain a handle on this one.
 */
export function desktopLinkClick(event: MouseEvent, open: (url: string) => void): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest('a[target="_blank"]');
  if (!anchor) return false;
  const href = anchor.getAttribute("href");
  if (!href || !/^https?:/i.test(href)) return false;
  event.preventDefault();
  open(href);
  return true;
}
