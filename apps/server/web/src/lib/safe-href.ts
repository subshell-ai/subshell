/**
 * The last check before a URL this page did not write becomes a link.
 *
 * Three anchors on the Networking surface take their `href` from data the
 * server sent: a hint's docs link, an install guide, and a privileged step's
 * vendor page. A plugin author wrote most of those, but not all — a hint's URL
 * can be something a plugin read off a vendor CLI, which read it off whichever
 * control server the operator configured. So the value arriving here is not
 * necessarily anybody's deliberate choice.
 *
 * An `href` is not inert. A `javascript:` URL in one runs script on this
 * origin, in the session of the one person allowed to install plugins, and
 * `target="_blank"` does not change that.
 *
 * **The server already strips these**, in two places: the manifest parser
 * refuses a non-http(s) `docsUrl` at load, and the network gate drops one a
 * plugin reports at runtime. This is the third, and it is here because the
 * other two are the ones that can be reasoned about wrongly — a new route, a
 * new field, or a plugin surface that forgets — while this one sits at the
 * sink and cannot be bypassed by anything upstream.
 *
 * It is deliberately NOT a reliance on React. React 19 does neutralize a
 * `javascript:` href, which is why this was never exploitable; a page's safety
 * should not rest on a rendering library's internals, and React 18 only warned.
 * @param value - the candidate URL, or undefined when the field was absent
 * @returns the URL when a browser may navigate to it, else undefined — so a
 *   caller renders no link at all rather than a dead one
 */
export function safeHref(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not absolute. A relative href would resolve against this SPA's own
    // origin, which is never what a vendor documentation link means.
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
}
