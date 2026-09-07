# @internal/desktop-client

## 0.2.0

### Minor Changes

- [`56a223c`](https://github.com/subshell-ai/subshell/commit/56a223c1cb977eb08fa5568594fd8791c4f957ca) Thanks [@theogravity](https://github.com/theogravity)! - The bundle identifier is now **`dev.subshell.client`** (it was
  `dev.subshell.node`), matching the app's name and its sibling's
  `dev.subshell.server`.
  
  macOS tracks an app BY its identifier, so a build installed under the old one is
  a **separate app** to the system: it keeps its own settings directory, its own
  notification permission grant, its own single-instance lock and its own saved
  window state, and this build starts from defaults rather than inheriting them.
  The enrolled node itself is untouched — that lives in the agent's own
  `~/.config/subshell`, not in this app's settings. Delete the old
  `Subshell Client.app` and, if you want the disk clean,
  `~/Library/Application Support/dev.subshell.node`.
  
  On Linux the settings directory moves from `~/.config/subshell-node` to
  `~/.config/subshell-desktop-client` — deliberately NOT `~/.config/subshell`,
  which is the agent's own config home.

- [`2ea8914`](https://github.com/subshell-ai/subshell/commit/2ea891437237b1213a3bd458908c99062beb0242) Thanks [@theogravity](https://github.com/theogravity)! - Renamed the app to **Subshell Client** (it was "Subshell Node"). The installed
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

## 0.1.0

### Minor Changes

- [`c694cdd`](https://github.com/subshell-ai/subshell/commit/c694cddf53a186a11c1e5e4e82e137fcfc6e149a) Thanks [@theogravity](https://github.com/theogravity)! - **Subshell Node** — a desktop app that registers this machine as a node.
  
  Paste a control plane's URL and a setup key and the app installs the agent it
  ships, enrols, registers a background service, and shows what the node is
  doing — no CLI, no `curl | bash`.
  
  It ships the `subshell` agent inside it, so nothing is downloaded on first run,
  and it installs that agent to `~/.local/bin/subshell` rather than running it
  from inside the bundle: a service points at an absolute path, and a path inside
  an app bundle breaks the moment the app is moved or replaced.
  
  Available for macOS (Apple silicon, signed and notarized) and Linux x86_64
  (`.deb`, Ubuntu 24.04+ / Debian 13+).
