---
"@internal/desktop-client": minor
---

**Open in Browser**, in the tray menu and under View — it hands the control
plane page you are looking at to your default browser, with your profile, your
password manager and your extensions. The plane's own sidebar grows the same
row, and a subshell's actions menu grows one that opens that subshell.

The browser will ask you to sign in: a webview's session does not cross to it.

This is the first thing the control plane's window in this app is allowed to
ask for. It asks for a PATH and nothing more — the address comes from the plane
this window is already pinned to — so a page cannot point the browser at a host
you did not choose. Everything that touches this machine, the agent or the
service is still reachable only from the app's own node window.
