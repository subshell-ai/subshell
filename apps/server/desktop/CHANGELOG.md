# @internal/desktop-server

## 0.5.0

### Minor Changes

- [`383158e`](https://github.com/subshell-ai/subshell/commit/383158ecd814437a018fed47d8b4476e6eefc3c0) Thanks [@theogravity](https://github.com/theogravity)! - Published artifacts now say **Desktop** in their names:
  `Subshell-Server-Desktop.app.tar.gz` and
  `subshell-server-desktop_<version>_amd64.deb`.
  
  Both CLIs ship from the same repo, so the old names sat in a downloads folder
  next to `subshell-server-cli-<triple>` — the bare server binary — with nothing to
  say which was the application.
  
  The suffix is on the file name only. The installed app is still
  `Subshell Server.app`, with the same window title, menu bar and bundle
  identifier, so an existing install upgrades in place.

## 0.4.0

### Minor Changes

- [`56a223c`](https://github.com/subshell-ai/subshell/commit/56a223c1cb977eb08fa5568594fd8791c4f957ca) Thanks [@theogravity](https://github.com/theogravity)! - The bundle identifier is now **`dev.subshell.server`** (it was
  `dev.subshell.desktop`), matching the app's name and its sibling's
  `dev.subshell.client`.
  
  macOS tracks an app BY its identifier, so a build installed under the old one is
  a **separate app** to the system: it keeps its own settings directory, its own
  notification permission grant, its own single-instance lock and its own saved
  window state, and this build starts from defaults rather than inheriting them.
  Delete the old `Subshell Server.app` and, if you want the disk clean,
  `~/Library/Application Support/dev.subshell.desktop`.
  
  On Linux the settings directory moves from `~/.config/subshell-desktop` to
  `~/.config/subshell-desktop-server` — deliberately NOT
  `~/.config/subshell-server`, which is where the `subshell-server` CLI keeps its
  own `config.env`.

- [`2ea8914`](https://github.com/subshell-ai/subshell/commit/2ea891437237b1213a3bd458908c99062beb0242) Thanks [@theogravity](https://github.com/theogravity)! - Renamed the app to **Subshell Server** (it was "Subshell"). The installed app is
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

## 0.3.0

### Minor Changes

- [`c694cdd`](https://github.com/subshell-ai/subshell/commit/c694cddf53a186a11c1e5e4e82e137fcfc6e149a) Thanks [@theogravity](https://github.com/theogravity)! - Renamed from `@internal/desktop` now that there are two desktop apps — this one
  wraps the server, and the new `@internal/desktop-client` wraps a node agent.
  
  **Releases now carry the tag prefix `desktop-server-v`** instead of `desktop-v`.
  Existing `desktop-v*` releases are unchanged.
  
  Nothing user-facing about the app itself changes: the bundle identifier,
  product name, artifact names and the settings file are all deliberately
  untouched, so an installed copy upgrades in place and keeps its settings. The
  Rust it shares with the new app moved to `crates/desktop-core`, and one settings
  key was renamed with a back-compatible alias.

## 0.2.0

### Minor Changes

- [`8168720`](https://github.com/subshell-ai/subshell/commit/816872044ec27192e616e03c6e62604a2063a8a1) Thanks [@theogravity](https://github.com/theogravity)! - Subshell Desktop — a native shell that installs, runs and manages a
  `subshell-server` on this machine, so using Subshell no longer starts with a
  CLI binary.
  
  It bundles the server, installs it to `~/.local/bin` and drives the whole
  lifecycle from a window: configure, install as a service, start, stop and
  restart, with the live-pane refusal surfaced rather than discovered. The app
  window shows the server's own UI at its own origin — so sessions, terminals and
  WebSockets behave exactly as they do in a browser — under a native title bar,
  menu bar and tray, with native notifications when an agent is waiting for you.
  
  macOS (Apple silicon) and Linux (x86_64 `.deb`, Ubuntu 24.04 and newer).
  `tmux` is required on the host: every local pane runs through it.
