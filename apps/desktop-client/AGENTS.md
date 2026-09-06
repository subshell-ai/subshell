# Desktop client AGENTS.md

`apps/desktop-client` (`@internal/desktop-client`) — **Subshell Node**, a
**Tauri v2** shell that registers this machine as a node and keeps its
`subshell` agent running, so a user never has to touch a CLI binary.

It is the sibling of `apps/desktop-server`, one layer down the stack: that app
wraps the control plane, this one wraps a node. Read that app's `AGENTS.md`
too — most of the machinery is the same and is documented there once.

## One window, and why that is the whole difference

`apps/desktop-server` has two windows because the thing it manages serves a web
UI, and `apps/frontend` is hard same-origin, so that UI has to be loaded from
the server's own HTTP origin. **A node serves nothing.** There is no page to
load, so this app has one window, it loads `ui/index.html` from the bundle, and
every piece of remote-content apparatus in the other app is absent here: no
second window, no `SubshellDesktop/…` user-agent marker, no `shell_ready`
title-bar handshake, no `on_navigation` pin, no `disable_drag_drop_handler`, no
1024px minimum width, no `bridge.rs` CustomEvent bus.

That also means the `csp` in `tauri.conf.json` is the real CSP for every page
this app shows, rather than a policy that covers only one of two windows.

## Commands

```bash
bun run dev:app             # tauri dev (needs a staged sidecar — see below)
bun run compile             # tauri build --debug
bun run test                # bun test src   (the TS half: the release script)
cd src-tauri && cargo test  # the Rust half — the ladder, the parsers, the policy
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

**Verify Linux in the container, not by reasoning.** Half this crate is
`#[cfg]`-gated, so `cargo clippy` on macOS cannot see what Linux compiles:

```bash
docker run --rm -v "$PWD/../..":/w -w /w ghcr.io/subshell-ai/desktop-builder:ubuntu24.04 \
  bash -euc 'rustup component add rustfmt clippy
             cd /w/apps/desktop-client/src-tauri
             install -m 755 /dev/null "binaries/subshell-node-bundled-$(rustc --print host-tuple)"
             cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test'
```

## The staged sidecar

`tauri-build` REFUSES to build when an `externalBin` file is missing, and
`src-tauri/binaries/*` is gitignored (it is a ~100 MB build input). So a fresh
clone cannot even `cargo test` until something is staged:

```bash
cd src-tauri && install -m 755 /dev/null "binaries/subshell-node-bundled-$(rustc --print host-tuple)"
```

A zero-byte stub is correct for the Rust tests — none of them executes the
sidecar, and `tauri-build` only checks that the path EXISTS. A real one comes
from `bun run compile:release`, which builds `apps/client` first.

**The staged name and the in-bundle name are different strings.** The release
script writes `subshell-node-bundled-<rust triple>`; Tauri STRIPS the suffix
when it copies the file, so inside the bundle it is `subshell-node-bundled`.
Anything grepping for the staged name inside a built bundle finds nothing, 100%
of the time.

**Why the `-bundled` suffix.** Tauri puts an `externalBin` in `/usr/bin` on
Debian. A sidecar named `subshell` would own that name system-wide on every
machine this app is installed on, and would collide with a hand-installed
agent — which is exactly the file this app has to be able to tell apart from
its own.

## Identity — four strings that must differ from `apps/desktop-server`

| | desktop-server | desktop-client |
| --- | --- | --- |
| Cargo crate | `subshell-desktop` | `subshell-desktop-client` |
| bundle identifier | `dev.subshell.desktop` | `dev.subshell.node` |
| `productName` | `Subshell` | `SubshellNode` |
| sidecar stem | `subshell-server-bundled` | `subshell-node-bundled` |

Both packages can be installed on one machine and both put a binary in
`/usr/bin` on Debian, so a shared string is a file conflict. The identifier is
additionally the macOS settings directory and the single-instance key, so
changing it after a release silently starts every existing user from defaults
and drops their notification permission.

`productName` is one token because Tauri derives BOTH the `.app` directory name
and the `.deb` filename from it, and the Debian package-name sanitizer cannot be
exercised without running the Linux bundler. The window title, tray tooltip and
menu titles read "Subshell Node" — those are free-form and are not
`productName`.

## Where things live

```
src-tauri/src/
├── agent_bin.rs   the resolution ladder for `subshell`, and the bundled-vs-installed policy
├── control.rs     the eight `node_*` commands, and Probe
├── windows.rs     the one window
├── tray.rs        tray icon + menu (an explicit id; a Menu attached, or Linux may not register it)
├── menu.rs        the macOS menu bar — module-gated, because Linux has none
└── lib.rs         plugins, environment scrubbing, lifecycle

ui/                the bundled page: no framework, no build step, no npm runtime dep
src/scripts/       the release script (TS) — `bun run compile:release`
```

Shared with `apps/desktop-server` via `crates/desktop-core`: process spawning
with a login PATH and a deadline, the login-shell PATH probe, semver
comparison, the settings file, and the atomic sidecar install. Do not
re-implement any of those here.

## The IPC boundary

`permissions/desktop.toml` is the app's ACL manifest and it is load-bearing **by
existence**, not only by contents: Tauri gates an app command when
`plugin_command.is_some() || has_app_acl_manifest || !is_local`. With one local
window every command is granted today — but delete that file and a second
window added later would inherit the whole CLI surface silently.

Command names live in that file and in `capabilities/main.json`. Changing one
without the other produces a command that is refused at runtime with a message
about permissions, not a compile error.

## Things that will bite

- **`subshell status` exits 1 whenever the node is offline.** The exit code is a
  hint; the JSON body on stdout is the answer. Treating non-zero as "the command
  failed" turns every stopped agent into an error dialog.
- **`subshell status --probe` is destructive.** The control plane's node registry
  is newest-wins, so a probe supersede-kicks a live agent (close 4409) —
  possibly one running on another machine for the same node. Nothing in this app
  may call it: not on a timer, not behind a button.
- **`enroll` has no already-enrolled guard.** It overwrites `config.json`, mints
  a SECOND node row on the server, and discards the old node key whose only home
  was that 0600 file. `node_enroll` therefore takes a `confirm` flag and spawns
  nothing until it is true.
- **A setup key is single-use and lasts 24 hours.** Everything checkable is
  checked before the server consumes it, but a 409 (name already taken) or a 500
  arrives AFTER — and spends it. Those say "mint a new key", never "retry".
- **A GUI process's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.** `service install`
  bakes `Environment=PATH=` from the environment it runs in, so without the
  login PATH the node comes up ONLINE with an empty harness inventory and 409s
  every launch — far from the cause. Every spawn goes through
  `desktop_core::proc`, which injects the login PATH.
- **Never spawn `subshell run`** — it never resolves, and it competes with the
  installed service for the same node; both restart on exit, so they flap.
  **Never spawn `subshell mcp`** — it is per-pane internal plumbing.
- **`SUBSHELL_CONFIG_HOME` is scrubbed from the process at startup**, because
  the service definition bakes only PATH: an agent enrolled under a relocated
  config home is started by a service that looks in `~/.config/subshell`, finds
  nothing, and crash-loops silently.
- **Restarting the agent can kill every pane on this machine.** A node runs its
  subshells' tmux servers as CHILDREN of its own unit, so a definition without
  `KillMode=process` / `AbandonProcessGroup` takes them all down. The CLI
  refuses such a restart without `--force`; surface the refusal and make the
  override a separate, labelled action.
- **The Linux tray may be silently invisible.** `TrayIconEvent` is never emitted
  there and a stock GNOME has no StatusNotifier host. Close-to-tray defaults OFF
  on Linux, the Rust side refuses to persist `true` there, and the page does not
  draw the switch — three guards, all deliberate.
- **The icon is currently the same mark as `apps/desktop-server`.** The brand
  generator needs a licensed font that is not in the repo, so a distinct node
  badge is a design task, not a code one. Two identical Dock icons is a real
  papercut and worth fixing.
