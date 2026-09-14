---
"@internal/desktop-server": minor
---

**Open in Browser**, in the tray menu and under View, right below "Open
Subshell Server" — it hands whatever the dashboard is showing to your default
browser. The dashboard's own sidebar grows the same row.

A desktop window is a webview: no address bar, no second tab, and no way to
reach the page you are looking at from the browser where your passwords and
profiles live. This is that way. Note that the browser will ask you to sign in
(a webview's session does not cross), and that the address opened is the
loopback one this app manages — so a passkey works there only if your server's
public base URL is the loopback address too.

The page asks for a PATH and nothing more; the app supplies the address. It
cannot be pointed at another host.
