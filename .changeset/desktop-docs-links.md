---
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Every docs link in both desktop apps opens in the system browser

Tauri denies a page's request for a new window — a `target="_blank"` link,
`window.open` — unless the window carries a handler, and it denies silently.
Both apps' windows carried none, so every "Docs" link the served pages offer,
the Tailscale card's among them, looked broken inside the app while working
in a browser.

Each window now answers the request itself: never an in-app webview (these
windows' capability files were written for one page each), http(s) handed to
the person's own system browser, and every other scheme dropped rather than
handed to the OS.
