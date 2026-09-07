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

The **bundle identifier stays `dev.subshell.desktop`** — an identifier is an
identity, not a label, and it keys the macOS settings directory, the
notification permission grant, the single-instance lock and the window-state
store. macOS tracks an app by identifier, so the renamed `.app` upgrades in
place and nobody starts over from defaults. The Cargo crate (`subshell-desktop`,
also the `/usr/bin` binary in the `.deb`), the sidecar stem
(`subshell-server-bundled`) and the `desktop-server-v` tag prefix are unchanged.
