---
"@internal/desktop-client": minor
---

Renamed the app to **Subshell Client** (it was "Subshell Node"). The installed
app is `Subshell Client.app` on macOS, and the window title, tray tooltip, menu
bar and the page's own heading all read Subshell Client.

Every published artifact name changes with it: `Subshell-Client.app.tar.gz` (was
`SubshellNode.app.tar.gz`) and `subshell-client_<version>_amd64.deb` (was
`SubshellNode_<version>_amd64.deb`). Published names are space-free because they
are download URLs and shell arguments; the `.app` inside the tarball keeps the
spaced product name.

The Cargo crate (`subshell-desktop-client`, also the `/usr/bin` binary in the
`.deb`), the sidecar stem (`subshell-node-bundled`) and the `desktop-client-v`
tag prefix are unchanged, and "node" still names the control-plane concept
everywhere it did.
