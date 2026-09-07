---
"@internal/desktop-server": minor
---

Renamed the app to **Subshell Server** (it was "Subshell"). The installed app is
`Subshell Server.app` on macOS, and the window titles, tray tooltip and menu bar
all read Subshell Server.

Every published artifact name changes with it: `Subshell-Server.app.tar.gz`
(was `Subshell.app.tar.gz`) and `subshell-server_<version>_amd64.deb` (was
`Subshell_<version>_amd64.deb`). Published names are space-free because they are
download URLs and shell arguments; the `.app` inside the tarball keeps the
spaced product name.

The Cargo crate (`subshell-desktop`, also the `/usr/bin` binary in the `.deb`),
the sidecar stem (`subshell-server-bundled`) and the `desktop-server-v` tag
prefix are unchanged.
