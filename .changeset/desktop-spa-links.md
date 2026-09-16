---
"@internal/server": patch
---

External links inside the desktop apps' windows open in the system browser

Every `target="_blank"` link the served pages render — the Tailscale card's
Docs links among them — did nothing when clicked inside Subshell Server or
Subshell Client. Instrumenting both webview callbacks with a self-clicking
probe measured where it dies: the click reaches the page's DOM on the right
anchor, and the webview then raises NOTHING at the app — neither the
navigation callback nor the new-window callback fires for an anchor click,
so no native handler can catch it. A `window.open` under the same click DOES
reach the app's new-window handler, which opens http(s) in the system
browser (fixed together with this, same spec).

So the page answers its own links when it runs in a desktop shell: a
capture-phase relay on the document turns a plain left-click on a
blank-target http(s) anchor into `window.open`, and the native handler stays
the security boundary — it re-checks the scheme and refuses everything else.
In an ordinary browser nothing is armed and the links behave as always.
