---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
---

Fix web previews losing asset bytes during large responses and HTTP reader handoffs, and keep Next.js chunk loading working through rewritten URLs. A replaced Turbopack stylesheet now refreshes in a Chromium preview, so a CSS edit shows up without reloading the page.

Discovery offers only the ports that answer with a website, and shows each page's title in the picker and its tab. A dev server is no longer hidden behind a pane full of idle sockets, or by an IPv4 that is not listening at all, or by a slow first compile, and an internal tool that ignores non-browser clients still appears because discovery now says what it is. What never answers at all stays out, which is what keeps a wedged database off the list. What gets offered is also what opens: a site on IPv6 stays out when IPv4 accepts and never answers, because the preview would hang on the stalled socket rather than reach it. A devtools endpoint bound to `::1` is now watched as well as listed, since discovery and the bridge both ask loopback's two families.

A navigation that would hand a phone's whole screen to a file shows a closeable error page instead, and the dashboard says so in a toast. A desktop click keeps downloading the way it did before. The refused response's cookies still reach the preview's jar, so the app isn't quietly signed out, and anything a browser renders itself, plain text, an image, a clip, JSON or XML, is shown rather than blocked. A server answering `application/xhtml+xml` counts as a website again. Discovery travels on node protocol 26, so update each node alongside the server.

Dashboard pages now run `seroval` 1.7.3, the release the router's own dependency range already permits, which clears five open advisories, three of them high.

Route alternate-screen history buttons to the running program, in the key form the app asked for. Use matching device and preview count badges, move ownership notices beside the action menu, and make their explanations available by tapping.
