# @internal/desktop-client

## 0.4.0

### Minor Changes

- [`63860fd`](https://github.com/subshell-ai/subshell/commit/63860fd73a3e0e9ab8fa0f818ce734a6038e09da) Thanks [@theogravity](https://github.com/theogravity)! - **Fixed: node management could become unreachable.** Once a control plane
  address was settled, startup opened only the plane window and the node window's
  only route back was the tray — which is silently invisible on any Linux desktop
  with no StatusNotifier host (a stock GNOME), and on a notched Mac whose Control
  Center has wedged. Enrolment, agent installation and service control were then
  unreachable, and relaunching did not help.
  
  Three routes now exist, and the app picks by asking rather than assuming:
  
  - macOS gets **Window → This machine…** in the menu bar, which is always drawn.
  - Where the tray probe says no icon would render, the node window opens at
    startup alongside the plane instead of waiting to be summoned.
  - Relaunching re-creates it there, so the recovery the tray notes have always
    prescribed actually works.
  
  **Fixed: switching control planes silently did nothing.** The plane window's
  navigation guard was pinned to the origin the window was BUILT with, and a
  `navigate()` to a different plane goes through that same guard — so the switch
  was refused, the old plane stayed on screen, and the command that asked for it
  reported success. The pin now follows a deliberate switch while still refusing a
  redirect, an href in rendered content, or an injected script.
  
  **Added: a way to change the plane.** The address is filled in automatically
  from an existing enrolment, so without this a machine enrolled against one plane
  could never be pointed at another from the app — and a typo'd-but-valid address
  was equally permanent.

## 0.3.0

### Minor Changes

- [`00abae8`](https://github.com/subshell-ai/subshell/commit/00abae82d4299f52433ba5f88694e42500aeabaf) Thanks [@theogravity](https://github.com/theogravity)! - **Subshell Client is now a client.** It opens the control plane's own UI in a
  native window — point it at a server's address and that is what you get — and
  registering this machine as a node moved into a second window, reached from the
  tray ("This machine…") and shown on a fresh install before an address is
  settled.
  
  That second window existing is the whole "node functionality" toggle: a client
  you only watch subshells from never opens it, and there is no mode flag for the
  two halves to disagree about. The address is remembered, and is picked up
  automatically from an existing enrolment.
  
  The window showing the plane's page is granted **no Tauri commands at all**. A
  control plane can live on any host, so its origin cannot be pinned in a
  capability file the way `apps/server/desktop` pins its own loopback server —
  so rather than widen anything, that window gets nothing, carries no
  desktop-shell user-agent marker, and is still pinned by `on_navigation` to the
  origin it opened with. Enrolment, agent installation and service control stay
  on the bundled page, which the plane cannot reach.

- [`383158e`](https://github.com/subshell-ai/subshell/commit/383158ecd814437a018fed47d8b4476e6eefc3c0) Thanks [@theogravity](https://github.com/theogravity)! - Published artifacts now say **Desktop** in their names:
  `Subshell-Client-Desktop.app.tar.gz` and
  `subshell-client-desktop_<version>_amd64.deb`.
  
  Both CLIs ship from the same repo, so the old names sat in a downloads folder
  next to `subshell-node-cli-<triple>` — the bare node agent — with nothing to say which
  was the application.
  
  The suffix is on the file name only. The installed app is still
  `Subshell Client.app`, with the same window title, menu bar and bundle
  identifier, so an existing install upgrades in place.

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
