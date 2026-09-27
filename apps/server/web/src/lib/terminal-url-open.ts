/**
 * Opening a URL a terminal surfaced — the ONE scheme decision every
 * terminal-originated open goes through (the click-to-open links of
 * `@xterm/addon-web-links`, and the copy-mode tap of `terminal-url-tap`).
 *
 * Terminal text is program output: whoever printed it chose the bytes, and a
 * terminal renders `javascript:`/`data:` just as happily as a link. So only
 * `http(s):` may be opened, matched on the string (case-insensitive, as URL
 * schemes are) before anything else asks. A refused URI is ignored, not
 * announced — a non-link token in scrollback is the common case, and a toast
 * per tap would be noise.
 *
 * `window.open` is deliberate, not an anchor: inside both Tauri shells only a
 * `window.open` from the page reaches the native `on_new_window` handler
 * (measured, `lib/desktop-links.ts`), which re-checks the scheme and hands
 * http(s) to the system browser — the shells' own boundary stays the boundary.
 * `noopener` because the opened window must not gain a handle on this one.
 */

/**
 * Opens `uri` in a new tab/window when it is an http(s) URL.
 *
 * @param uri - the candidate, verbatim from terminal text (never repaired)
 * @returns whether the URI was opened; anything non-http(s) opens nothing
 */
export function safeOpenTerminalUri(uri: string): boolean {
  if (!/^https?:/i.test(uri)) return false;
  window.open(uri, "_blank", "noopener");
  return true;
}
