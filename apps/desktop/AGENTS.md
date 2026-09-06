# Desktop AGENTS.md

`apps/desktop` (`@internal/desktop`) — a **Tauri v2** shell that installs, runs
and manages a `subshell-server` on this machine, so a user never has to touch a
CLI binary.

## The two windows, and why they are two

| Window | Page | Why |
| --- | --- | --- |
| `console` | `ui/index.html`, bundled, `tauri://` | Must render with the server **down**, and is the only surface allowed to drive the CLI. |
| `main` | the SERVER's own SPA over `http://127.0.0.1:<port>` | `apps/frontend` is hard same-origin. |

**`main` never loads a bundled copy of the SPA.** `src/lib/api.ts` fetches
root-relative with `credentials: "include"`, `src/lib/auth-client.ts` sets no
`baseURL`, `src/lib/use-subshell-ws.ts` builds its WebSocket URL from
`window.location.host`, and there are zero `import.meta.env` reads in the whole
frontend. A `tauri://localhost` page cannot carry the `SameSite=Lax; httpOnly`
session cookie to any of them, and admin routes reject bearer keys by design —
so serving the SPA ourselves would mean an auth rework, not a build change.

## Commands

```bash
bun run dev:app             # tauri dev (needs a staged sidecar — see below)
bun run compile             # tauri build --debug
bun run test                # bun test src   (the TS half)
cd src-tauri && cargo test  # the Rust half — the ladder, the parsers, the policy
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

The Rust half runs in CI as its own `desktop-rust` job in
`.github/workflows/test.yml` — it cannot ride `bun run test`, which runs on a
plain `ubuntu-latest` with no Rust toolchain and none of Tauri's system deps.

**Verify Linux-only lints in a container, not by reasoning.** Half this crate
is `#[cfg]`-gated, so `cargo clippy` on a Mac cannot see what Linux compiles —
a module gated at its CALL SITE rather than at the module is entirely dead code
there, and a `match` whose only other arm is `#[cfg(macos)]` collapses to one
arm plus a wildcard. Both failed CI after passing locally:

```bash
docker build -f docker/desktop-builder.Dockerfile -t desktop-builder:local .
docker run --rm -v "$PWD":/w -w /w/apps/desktop/src-tauri desktop-builder:local bash -c '
  rustup component add rustfmt clippy
  install -m 755 /dev/null "binaries/subshell-server-bundled-$(rustc --print host-tuple)"
  export CARGO_TARGET_DIR=/tmp/target
  cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test'
```

`--platform linux/arm64` on Apple silicon runs natively and answers the same
question: `#[cfg(target_os)]` does not care about the architecture.

**A clean checkout cannot compile this crate without a staged sidecar.**
`tauri-build` refuses to build when an `externalBin` file is missing, and
`binaries/*` is gitignored — so `cargo test` on a fresh clone fails with
`resource path … doesn't exist` before a single test runs. CI stages a
zero-byte STUB, which is all `tauri-build` checks for and all the Rust tests
need (none of them executes the sidecar). Locally, stage a real one with the
recipe below if you also want to run the app.

`bun run compile:release` (`src/scripts/release.ts`) is the release pipeline:
it builds the SERVER first and stages it as the sidecar, then bundles, asserts
the exact bundle set, digests and publishes into `dist-rel/`. CI drives it per
shard from `.github/workflows/release.yml`; the root `AGENTS.md` carries the
operator-facing version.

**There is deliberately no `build` script.** `bun run build` runs on hosted
`ubuntu-latest` in both `test.yml` and `lint.yml`, where there is no Rust
toolchain, so cargo must stay structurally out of the turbo `build` graph —
the same discipline `apps/mobile` uses to keep Xcode out. There is also **no
`dev` script**: root `bun run start` is `turbo watch dev`, which would
otherwise launch a Tauri window for everyone.

## The staged sidecar

`bundle.externalBin` is `binaries/subshell-server-bundled`. The staged file
carries the **Rust** triple (`…-aarch64-apple-darwin`); Tauri **strips** that
suffix on copy, so inside the bundle — and beside the dev binary — it is just
`subshell-server-bundled` (`BUNDLED_SIDECAR_NAME` in `src-tauri/src/sidecar.rs`).
Those are two different strings and both are needed: anything grepping for the
staged name inside a built bundle finds nothing, 100% of the time.

To stage one by hand for `tauri dev`:

```bash
SUBSHELL_SERVER_RELEASE_TRIPLES=darwin-arm64 \
SUBSHELL_SERVER_RELEASE_DIR="$PWD/apps/desktop/src-tauri/binaries" \
  bun run release:server
cd apps/desktop/src-tauri/binaries \
  && mv subshell-server-darwin-arm64 subshell-server-bundled-aarch64-apple-darwin \
  && rm -f subshell-server-darwin-arm64.sha256
```

Three rules about that binary:

- **`compile:release`, never `compile`.** Only the release build embeds the SPA
  (`src/generated/embedded-web.ts`); the plain `compile` ships the tracked stub
  with `EMBEDDED = false`, and `selectStaticPlugin` then throws at boot on a
  user's machine, where there is no `apps/frontend/dist` to fall back to.
- **Delete the `.sha256` sidecar.** It describes the bytes BEFORE Tauri re-signs
  the nested binary with `--force`, so it is a lie the moment the `.app` is
  sealed. Digests are never comparable between the bare-binary download channel
  and this one.
- **Never pre-sign or separately notarize it.** Tauri signs nested binaries
  inside-out with the bundle's single entitlements slot, and the app-level
  notarization mints tickets for nested files. A pre-minted ticket binds to a
  cdhash Tauri is about to replace.

`binaries/*` is gitignored — it is a ~110 MB build input.

## Where things live

```
src-tauri/src/
├── lib.rs         # plugins, command registration, setup (opens `console` FIRST)
├── windows.rs     # the two windows, the 1024px floor, the UA marker
├── control.rs     # the tauri commands — argument-poor wrappers over the CLI
├── server_bin.rs  # the resolution ladder, ExecStart parsing, bundled-vs-installed policy
├── sidecar.rs     # the shipped server, and installing it atomically
├── proc.rs        # every spawn: login PATH + a deadline
├── shell_env.rs   # the PATH a GUI app does not have
├── settings.rs    # three fields, one JSON file
├── version.rs     # semverLt, mirrored from the protocol package
├── bridge.rs      # the DesktopAction enum and the eval dispatch
├── menu.rs        # the macOS menu bar
└── tray.rs        # the tray icon and its menu
```

## The IPC boundary

`src-tauri/permissions/desktop.toml` is the app's own ACL manifest, and its
**existence** is the boundary — not just its contents. Tauri gates an app
command when `plugin_command.is_some() || has_app_acl_manifest || !is_local`
(tauri 2.11.5, `webview/mod.rs`). Without that file every app command is
ungated for every LOCAL window, so any window added later would silently
inherit the ability to drive the CLI.

With it, the split is enforced:

| Window | Gets |
| --- | --- |
| `console` | every command — it is the control surface |
| `main` | `desktop_open_console`, `desktop_shell_ready`, `desktop_notify`, and window dragging — over loopback only |

`main`'s three are chosen for what they cannot do: show a window that already
exists, drop this app's own title bar, and display one notification with a
fixed shape. Nothing that touches the CLI, the config, the service or the
filesystem is reachable from a page the server serves.

`main`'s page is served by the subshell-server this app manages, so it is
treated as remote content. `capabilities/main.json` carries `remote.urls`
scoped to loopback, and `open_main` additionally refuses a non-loopback origin
and pins `on_navigation` to the origin it was opened with — three independent
gates, because the window holds privileged globals.

The console has a real CSP (`script-src 'self'`), which is why its logic lives
in `ui/main.js` rather than inline.

## Native chrome

| Surface | macOS | Linux |
| --- | --- | --- |
| Menu bar | full `NSMenu` | none — a GTK menu bar is per-window chrome, not a system bar |
| Tray | icon + menu, click opens | icon + menu only; **click events are never emitted** |
| Title bar | Overlay, negotiated (below) | ordinary |
| Close to tray | offered, default off | **not offered at all** |

`PredefinedMenuItem::{cut,copy,paste,select_all}` come FIRST in the Edit menu
and are not decoration: without them ⌘C/⌘V do not work at all in a Tauri macOS
webview, because the shortcuts go to the menu bar and nothing claims them. In a
terminal app that is a correctness bug.

Close-to-tray is not offered on Linux and the Rust side refuses to persist it
there. `TrayIconEvent` is never emitted on Linux and a stock GNOME has no
StatusNotifier host, so the icon can be **silently invisible** — a window
hidden to an icon that is not there is unreachable, with nothing to explain it.
Every tray action therefore also exists in the window UI or the menu bar; the
tray is a shortcut, never the only route.

### Notifications

The web path is VAPID push through a service worker, and
`apps/frontend/src/lib/notifications.ts` gates on `PushManager` — which neither
WKWebView nor WebKitGTK has. A tray-resident window with no way to say an agent
is waiting undercuts the point of a tray, so the desktop notifies natively off
the SSE feed the app is ALREADY reading: no server work, no VAPID keys, and one
`desktop_notify` command rather than granting the server-origin page the whole
notification plugin.

Edge-triggered, deliberately: `use-desktop-notifications.ts` holds the previous
waiting set and starts it `undefined`, so a subshell that was already waiting
when the window opened is not news. Without that, opening the app fires one
notification per idle agent.

### The title-bar negotiation

The main window is created HIDDEN with an ordinary title bar. The SPA's desktop
sidebar calls `desktop_shell_ready({overlay: true})` on mount; the shell then
switches to `TitleBarStyle::Overlay` and shows the window. A six-second
fallback shows it decorated regardless.

It is a handshake rather than a version check because the desktop chrome ships
inside the SERVER's embedded SPA, so a desktop build can meet an instance that
has never heard of it — and an old SPA under a chrome-less window is an
UNMOVABLE window. A version floor would have to be kept in step with a release
it cannot see; asking the page is a fact. An old SPA simply never answers.

## Things that will bite

- **A GUI app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.** No `/opt/homebrew/bin`,
  no `~/.local/bin`. `service install` runs a tmux preflight through an injected
  `which`, AND bakes `Environment=PATH=` from the installing process — so
  without `shell_env.rs` you get either a refusal or, worse, a service that
  installs cleanly and then cannot launch a single pane. Every spawn goes
  through `proc::run`, which injects the login PATH.
- **`execLine()` records two tokens for a dev-form install.**
  `ExecStart=/path/to/bun /repo/apps/server/src/index.ts`. Anything reading a
  service definition must carry both or it runs bun with nothing to run.
- **`disable_drag_drop_handler()` on `main` is load-bearing.** Tauri's native
  file-drop handler otherwise swallows HTML5 drag events, which silently breaks
  both drag-a-subshell-into-a-workspace (the `application/x-subshell-id`
  payload) and the terminal's own file-drop uploads.
- **`min_inner_size` is 1024×640, not a preference.** `useIsWide()` is
  `matchMedia("(min-width: 1024px)")`; below it the SPA renders its PHONE
  drawer — the exact chrome this app exists to replace.
- **Never downgrade the installed server.** Boot runs
  `migrator.migrateToLatest()`, which is forward-only. `decide_server` offers a
  newer bundled server and ADOPTS a newer installed one; the reverse is data
  loss, not a choice to present.
- **Icons** are generated with `tauri icon` from
  `apps/frontend/public/icons/icon-512.png`, itself a `brand/` output. Regenerate
  them from the brand master, never by hand.

- **`proc::run` drains both pipes on threads, and that is not tidiness.**
  Waiting for exit and reading afterwards is the classic pipe deadlock, and it
  failed in both directions here (measured): 128 KiB of stdout turned a 5 ms
  command into a 3 s "timeout" with the child SIGKILLed, and a command leaving
  a backgrounded descendant held the pipe open so a 2 s deadline returned after
  8 s with `timed_out: false`. Both are regression tests now.
- **Nothing in `shell_env.rs` may use `Command::output()`.** It runs the user's
  own login profile — arbitrary code, on every launch — inside the `OnceLock`
  that every spawn waits on. It uses `proc::run_with_path` with a bootstrap
  PATH, because `proc::run` would recurse into the lock it is filling.
- **A `status --json` that does not answer is `Unreachable`, never `Init`.**
  `init` REWRITES `config.env`, so reading a transient failure as "unconfigured"
  would destroy a working configuration to fix nothing.
- **The upgrade offer compares against the MANAGED copy.** Installing to
  `~/.local/bin` cannot change what a service pointing elsewhere runs, so
  offering it for a server the user installed themselves would repeat forever.
- **`minimumSystemVersion` is 13.0 because the SIDECAR says so.** `otool -l`
  reports `minos 13.0` for the Bun-compiled server and 11.0 for the Rust
  binary; the bundle floor is the max of the two, and getting it wrong means an
  app that installs and then cannot start its own server.
