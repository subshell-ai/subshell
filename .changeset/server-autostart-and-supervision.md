---
"@internal/server": minor
"@internal/desktop-server": minor
---

Whether the server runs in the background, and whether it starts at every login, are two questions you can answer instead of two things the setup screen assumed.

`subshell-server service enable` and `service disable` arm and disarm start-at-login without touching the running process, and `service install --no-autostart` installs a service that runs now but does not come back. The dashboard's Service page carries the same switch (`POST /api/admin/server/autostart`), which is the one service control a served page gets — it changes nothing about the running process, so the page asking for it cannot take itself down. It is disabled with the reason where the question has no answer: nothing installed, the desktop app running this server, or a manager that would not say.

The Subshell Server setup screen's "Start it in the background, and at every login" is now two checkboxes, both checked by default. Unchecking the first runs the server as the app's own child — alive while the app is open, stopped when you quit, with running subshells kept — and the dashboard reports that honestly, so Restart server keeps working there. A new "How Your Server Runs" screen, reachable from the Service page, switches between the two later.

On macOS, "starts at login" is now which directory the launchd plist lives in rather than a key inside it. `RunAtLoad=false` does not stop a `KeepAlive=true` job (measured), and `launchctl disable` makes "running now but not at login" inexpressible while leaving a mark that survives uninstall.
