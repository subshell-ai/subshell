# Desktop client AGENTS.md

`apps/client/desktop` (`@internal/desktop-client`) — **Subshell Client**, a
**Tauri v2** shell that is a user's interface to a control plane, and the place
their machine is registered as a node — so neither job needs a CLI binary.

Read `docs/superpowers/specs/2026-09-07-app-vocabulary-design.md` first if the
words are new. Three of them each name exactly one thing: a **server** is a
control plane, a **node** is a machine that runs agents, a **client** is a human
interface to a control plane. This app is a client that can also make its
machine a node — which is why "node" appears all over it without contradiction:
the machine it registers IS a node, the `node_*` commands act on it, the
server's Nodes page lists it, and the sidecar stem names the agent it wraps.

It is the counterpart of `apps/server/desktop`, and the two are shaped alike:
each has a window holding a remote page and a window holding its own bundled
one. Read that app's `AGENTS.md` too — most of the machinery is documented there
once.

## Two windows, and why that is the whole design

| window | page | granted |
|---|---|---|
| `main` | the control plane's own UI, at the plane's origin | **nothing** |
| `node` | `ui/dist/index.html`, from the bundle | every `node_*` command |

`main` loads the plane's own page rather than a bundled copy because
`apps/server/web` is hard same-origin — relative `apiFetch` with
`credentials: "include"`, an auth client with no `baseURL`, a WebSocket URL
built from `window.location.host` — so a `tauri://` page could not carry the
`SameSite=Lax` session cookie to any of them.

**No capability file names `main`, and that absence is the security boundary.**
`apps/server/desktop` can pin its remote window to loopback because it manages
the server serving it; a control plane can live on any host, so there is no
equivalent pin here — and a window whose origin cannot be enumerated ahead of
time gets no commands at all. Two consequences follow and are deliberate:

- **No `SubshellDesktop/…` user-agent marker on that window.** That marker is
  how `apps/server/web` decides it is in a desktop shell and starts talking to
  Tauri (overlay title bar, window drags); with no grant those calls would be
  refused one at a time. Without it the SPA renders exactly as it does in a
  browser, which is right for a window that is one. So there is no
  `shell_ready` handshake and no `bridge.rs` CustomEvent bus here either.
- **What IS kept:** an `on_navigation` origin pin, `disable_drag_drop_handler`
  (Tauri's native file-drop handler otherwise swallows the HTML5 drags behind
  drag-a-subshell-into-a-workspace and the terminal's uploads), and the 1024px
  minimum width that keeps the SPA off its phone drawer.

**The node window existing is the whole "node functionality" toggle.** A client
used only to watch subshells never opens it; there is no mode flag for the two
halves to disagree about. A fresh install lands on it — `open_at_startup` leads
with the plane window only when an address is already settled (the stored
`planeUrl`, else the enrolled node's own `serverUrl`).

**It must always have a route home, and the tray is not one.** The plane window
is remote content granted nothing, so it cannot offer a way back, and a tray
icon is silently invisible wherever no StatusNotifier host is registered. So:
macOS gets **Window → This machine…** in the menu bar (always drawn, which also
covers the notched-display hazard in `tray.rs`); everywhere else,
`node_window_has_a_route_home()` asks `desktop-core`'s tray probe and, when the
answer is no, `open_at_startup` puts the node window on screen alongside the
plane and `focus_any` RE-CREATES it — so relaunching, which is what `tray.rs`
calls the way back from an invisible tray, actually is one.

The `csp` in `tauri.conf.json` governs the **bundled** page only. The plane's
window carries whatever CSP the plane sends, which is the same split
`apps/server/desktop` has — and the reason nothing privileged lives there.

## The page (`ui/`) — React, on the same stack as `apps/server/web`

`ui/` is a small **React + Vite + Tailwind v4 + TanStack Query** app, built to
`ui/dist` (the `frontendDist`). It mirrors `apps/server/web`'s stack minus what
the bundled page has no use for: no router (one page and a step machine, so
there are no URLs), no xterm, no dockview, no better-auth, no
`@internal/backend-client`. Every shared version is pinned to the same string
`apps/server/web/package.json` uses — `bun run syncpack:lint` fails otherwise.

Three things about it are load-bearing:

- **The typed IPC contract is `ui/src/lib/ipc.ts`**, one narrow function per
  `node_*` command, transcribed from `src-tauri/src/control.rs`. Nothing
  generates it, so `ui/src/__tests__/ipc-acl.test.ts` reads
  `permissions/desktop.toml` and `capabilities/node.json` and asserts the
  granted command set is exactly the invoked one. That three-way mismatch is a
  runtime permission rejection, not a compile error. The same file asserts that
  NO capability names the `main` window.
- **`withGlobalTauri` is `false`.** `invoke` is imported from
  `@tauri-apps/api/core`; `window.__TAURI__` existed only for the framework-free
  page and is gone.
- **Design tokens and the `components/ui/` primitives are COPIED** from
  `apps/server/web`, verbatim except the `cn` import path. Copied rather than
  shared so extracting them into a package later is a straight move, and so a
  diff between the two copies is the drift signal.

## Native prerequisites

**Neither the root `README.md`'s Requirements list nor `bun install` covers
these.** Every workflow that builds this app runs INSIDE
`ghcr.io/subshell-ai/desktop-builder:ubuntu24.04`
(`docker/desktop-builder.Dockerfile`), which already carries them — so CI can
never discover that a bare machine cannot build here, and the list lived only
in that Dockerfile until it was written down here.

```bash
# Rust — MSRV 1.82 (`rust-version` in all three Cargo.toml); CI installs
# rustup `stable`, exactly as the builder image does.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
  -y --profile minimal -c rustfmt -c clippy

# Linux (Debian/Ubuntu) — the subset of the builder image that Tauri links against
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev libgtk-3-dev build-essential pkg-config
```

`rustfmt` and `clippy` are not optional extras: `bun run rust:check` (and the
`desktop-rust` CI job) runs `cargo fmt --check` and
`cargo clippy --all-targets -- -D warnings` before `cargo test`.

macOS needs only the Xcode command-line tools — the system WebKit is what Tauri
links against there, so none of the packages above have a Homebrew counterpart.

**The minimum glibc is 2.39, by choice**, because the builder image is
ubuntu24.04 — which excludes Ubuntu 22.04 and Debian 12. Building on an older
host is not a supported configuration; the root `AGENTS.md` carries the
reasoning and the lever.

Check what is missing rather than guessing, since a missing library surfaces as
a `cargo` link error deep in a build script rather than as a clear message:

```bash
for p in webkit2gtk-4.1 gtk+-3.0 libsoup-3.0 ayatana-appindicator3-0.1 librsvg-2.0 openssl; do
  pkg-config --exists "$p" && echo "OK      $p" || echo "MISSING $p"
done
# `libxdo-dev` ships NO pkg-config file on Debian/Ubuntu, so it is checked
# separately — asking pkg-config about it reports a false MISSING on a host
# where it is installed.
dpkg -l libxdo-dev >/dev/null 2>&1 && echo "OK      libxdo-dev" || echo "MISSING libxdo-dev"
```

## Commands

```bash
# From the REPO ROOT, the command that builds the CLI and stages it first —
# and refreshes ~/.local/bin/subshell, which is what this app
# actually runs (the sidecar is on no rung of the ladder; root AGENTS.md):
#   bun run dev:desktop-client
bun run dev:app             # tauri dev (needs a staged sidecar — see below);
                            # runs `dev:ui` for you via beforeDevCommand
bun run dev:ui              # just the Vite dev server, on :5177
bun run build               # vite build -> ui/dist   (pure JS; safe in CI)
bun run compile             # tauri build --debug
bun run test                # bun test src  +  bun test in ui/  (see below)
bun run verify-types        # both tsconfigs: src/ (bun) and ui/ (react)
cd src-tauri && cargo test  # the Rust half — the ladder, the parsers, the policy
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

There is deliberately **no `dev` script**: root `bun run start` is
`turbo watch dev`, and a `dev` task here would spawn a Vite server for everyone
working on the backend. The Vite port is **5177**, not a neighbour of
`apps/server/web`'s 5174 — Vite walks upward from a taken port, and `devUrl` is a
fixed string, so 5175 is exactly where the SPA lands when its own port is busy.

**Two `bun test` runs, two configs.** `bun test src` covers the release script
with plain bun and NO DOM; `cd ui && bun test` picks up `ui/bunfig.toml`, which
preloads `ui/src/test-setup.ts` (happy-dom + the React act flag) for the
component tests. bunfig is resolved from the cwd, which is the whole reason the
web half's config lives in `ui/` rather than at the package root.

**Verify Linux in the container, not by reasoning.** Half this crate is
`#[cfg]`-gated, so `cargo clippy` on macOS cannot see what Linux compiles:

```bash
docker run --rm -v "$PWD/../..":/w -w /w ghcr.io/subshell-ai/desktop-builder:ubuntu24.04 \
  bash -euc 'rustup component add rustfmt clippy
             cd /w/apps/client/desktop/src-tauri
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
from `bun run compile:release`, which builds `apps/node/agent` first.

**Three names, one binary.** `apps/node/agent`'s own pipeline publishes it as
`subshell-node-cli-<triple>` (the `cli` says bare-binary, against this app's
`Desktop`), which is what `stageSidecar` looks for after the nested build. The
release script then MOVES it to `subshell-node-bundled-<rust triple>`, and Tauri
STRIPS that suffix when it copies the file, so inside the bundle it is
`subshell-node-bundled`. Anything grepping for the staged name inside a built
bundle finds nothing, 100% of the time.

**Why the `-bundled` suffix.** Tauri puts an `externalBin` in `/usr/bin` on
Debian. A sidecar named `subshell` would own that name system-wide on every
machine this app is installed on, and would collide with a hand-installed
agent — which is exactly the file this app has to be able to tell apart from
its own.

## Identity — four strings that must differ from `apps/server/desktop`

| | desktop-server | desktop-client |
| --- | --- | --- |
| Cargo crate | `subshell-desktop` | `subshell-desktop-client` |
| bundle identifier | `dev.subshell.server` | `dev.subshell.client` |
| `productName` | `Subshell Server` | `Subshell Client` |
| sidecar stem | `subshell-server-bundled` | `subshell-node-bundled` |
| published `.dmg` | `Subshell-Server-Desktop-<v>-darwin-arm64.dmg` | `Subshell-Client-Desktop-<v>-darwin-arm64.dmg` |
| published `.deb` | `subshell-server-desktop_<v>_amd64.deb` | `subshell-client-desktop_<v>_amd64.deb` |

Both packages can be installed on one machine and both put a binary in
`/usr/bin` on Debian, so a shared string is a file conflict. The identifier is
additionally the macOS settings directory
(`crates/desktop-core`'s `SettingsPaths`), the notification permission grant,
the single-instance lock and the window-state store, and macOS tracks an app BY
it — an identity rather than a label, which is why
`src/scripts/__tests__/release.test.ts` and `src-tauri/src/lib.rs` both pin it.

**The Linux settings directory is `subshell-desktop-client`, not `subshell`.**
`~/.config/subshell` is the AGENT's own config home
(`apps/node/agent/src/config.ts` — `config.json` and the 0600 node key), and this
app writing `settings.json` in beside it would put two programs' state in one
directory. `apps/server/desktop` is prefixed for the same reason, against the
server CLI's `~/.config/subshell-server`.

Cargo crate names and sidecar stems are deliberately not renamed in step with
the products: the crate name is the `/usr/bin` binary in the `.deb`, and the
sidecar stem names the binary this app WRAPS rather than the app.

`productName` may contain a space: Tauri derives the `.app` directory name, the
DMG volume and the `.deb` file name from it, and the Debian one goes through a
package-name sanitizer nobody can predict without running the Linux bundler —
so the release script does not predict names. It globs `bundle/<dir>` for the
ONE artifact that appeared and publishes it under the name
`desktopArtifactFileName` chooses (space-free: these are download URLs and
shell arguments). The `.app` inside that mounted image is `Subshell Client.app`,
space included, which is why the smoke quotes its paths. Tauri only SIGNS the
image (it notarizes/staples the `.app` and stops), so the pipeline runs
`notarizeAndStapleDmg` before digesting — and the smoke's `stapler validate` on
the IMAGE is what proves it.

The window title, tray tooltip and menu titles read "Subshell Client" — those
are free-form and are not `productName`.

## Where things live

```
src-tauri/src/
├── agent_bin.rs   the resolution ladder for `subshell`, and the bundled-vs-installed policy
├── control.rs     the thirteen `node_*` commands, and Probe
├── windows.rs     the two windows — the plane's page, and the bundled node page
├── tray.rs        tray icon + menu (an explicit id; a Menu attached, or Linux may not register it)
├── menu.rs        the macOS menu bar — module-gated, because Linux has none
└── lib.rs         plugins, environment scrubbing, lifecycle

ui/                the bundled page (React + Vite + Tailwind), built to ui/dist
├── src/lib/       ipc.ts (the typed command contract), steps.ts, copy.ts, cn.ts
├── src/hooks/     the two queries, the serializing action runner, the commands
├── src/components/ui/   primitives copied from apps/server/web
└── src/components/      the screens (step-screens.ts holds the words)
vite.config.ts     the web build; `ui/` is its root
src/scripts/       the release script (TS) — `bun run compile:release`
```

Shared with `apps/server/desktop` via `crates/desktop-core`: process spawning
with a login PATH and a deadline, the login-shell PATH probe, semver
comparison, the settings file, the atomic sidecar install, and the tray
capability probe that gates close-to-tray. Do not re-implement any of those
here. (`src-tauri/src/tray.rs` is the ICON — builder, menu, ids;
`desktop-core`'s `tray.rs` is the different question of whether an icon is
drawn on this desktop at all.)

## The IPC boundary

`permissions/desktop.toml` is the app's ACL manifest and it is load-bearing **by
existence**, not only by contents: Tauri gates an app command when
`plugin_command.is_some() || has_app_acl_manifest || !is_local`. Delete it and
every command becomes ungated for every local window — which now matters
concretely, because there are two windows and only one of them may drive the
CLI.

Command names live in that file and in `capabilities/node.json`. Changing one
without the other produces a command that is refused at runtime with a message
about permissions, not a compile error. `ui/src/__tests__/ipc-acl.test.ts`
reads both files and the invocations in `ui/src/lib/ipc.ts`, and fails on any
three-way mismatch — add the command in all three or the test names the one
you missed.

## The node page is the console (parity with the server app)

The same rules the Subshell Server console enforces, and for the same reasons
(2026-09-08 port):

- **Reveals name an intent, never a path.** `node_open_path` takes the closed
  `config-dir | data-dir | agent-log` enum; the Linux `agent-log` rejection IS
  the `journalctl` command, and the facts list now also shows the log location
  (the CLI's `logPath` shape: a file on macOS, the journal sentence on Linux)
  so it is readable without clicking.
- **About is a FOOTER, and it owns no strings.** `components/about-footer.tsx`
  renders the same content as the Subshell Server console's About section —
  mark, app name, both versions, links, terms, copyright, centred — from one
  `node_about` call, so the facts live only in `crates/desktop-core/src/legal.rs`
  (which `scripts/license-fields.ts` holds equal to the TypeScript copy and to
  the root LICENSE). A footer rather than a section because this window is one
  flow with nothing to navigate between, and rather than a dialog because the
  CSP rules below put portalled primitives out of reach. macOS already has an
  About box in the app menu from the same constants; Linux has no menu bar, and
  nobody should need to know which platform convention applies to find a
  version number. Its three links go through `node_open_web`, a closed enum —
  the addresses travel to the page for DISPLAY and never travel back.
- **The plane's second door.** `node_open_plane_url` opens the settled control
  plane in the SYSTEM browser — for the browser the in-app window is wrong
  for (a different profile, a share, passkeys). Like the server app's twin,
  the page passes NO URL: the command re-reads the same ladder
  `node_open_plane` points a window at, and `validate_server_url` admits
  http(s) only.
- **tmux is a gate, not a caption.** `StepAction.needsTmux` disables Enroll /
  Install-and-start / Start / Restart while the probe cannot find tmux —
  `enroll` refuses CLI-side and a tmux-less node comes up online with no
  harnesses, so a live button only manufactures the failure. Stop, Uninstall
  and the reveals stay live (disabling those strands the box), the hint names
  the install command (`TMUX_INSTALL_CMD`), and the gate reads the CURRENT
  probe, so installing tmux and refreshing re-arms the buttons.
- **The manager row says what the manager said.** `probe-facts` appends the
  service `detail` verbatim (`launchd: spawn scheduled` is the crash-throttle
  wait) and paints `state: unknown` bad — a manager that would not answer is
  not the same fact as a stopped agent. That detail is the AGENT CLI's: the
  classification was ported into `apps/node/agent/src/service.ts` from the
  server CLI's 2026-09-07 hardening, plist association included
  (`AssociatedBundleIdentifiers`, one constant with the app's bundle id).

## Things that will bite

- **The CSP blocks inline style ATTRIBUTES, not just `<style>` elements.**
  `style-src 'self'` with no `'unsafe-inline'` means a React `style={{…}}` prop
  is a silently unstyled element — no error, no warning, and it looks correct
  under `tauri dev`, where `app.security.devCsp` relaxes exactly that rule so
  Vite's HMR works. Tailwind classes only; `ui/src/__tests__/no-inline-styles.test.ts`
  fails on a `style` prop or `dangerouslySetInnerHTML` anywhere under `ui/src`.
  For the same reason, **do not reach for a portalled or anchored Base UI
  component** (popover, tooltip, select): they position themselves with inline
  styles. And Vite's module-preload polyfill is an inline `<script>`, which is
  why `modulePreload.polyfill` is off in `vite.config.ts`.
- **Base UI's `Switch` needs a stylesheet workaround for that.** `Switch.Root`
  renders a hidden native checkbox — as a SIBLING of the root, not a child — and
  hides it with an inline style, so under the shipped CSP it becomes a visible
  stray checkbox. `ui/src/styles.css` restates the hiding from a stylesheet;
  `ui/src/__tests__/switch-csp.test.tsx` fails if Base UI stops emitting that
  input, at which point delete both.
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
  nothing until it is true. **`node_configure` is the non-destructive one** —
  `subshell configure --server` repoints an enrolled node, keeps its identity
  and spends no setup key, so it is deliberately ONE click with no confirm
  phase. Asking there would teach the user that a repoint costs what a
  re-enrol costs, which is the confusion the separate command removes.
- **This app holds TWO control-plane addresses.** Its own `planeUrl` (what the
  plane window opens) and the node's `serverUrl` in `config.json` (what the
  daemon dials). `plane_url_from` falls back to the second only when the first
  is unset, so once a preference exists the two drift freely — and every
  surface showed exactly one of them, which made a drift invisible: the app
  would show a plane while this machine's subshells reported to another.
  `node_configure` now writes BOTH, and `lib/plane-coherence.ts` +
  `components/node-plane-card.tsx` name the pairs that predate it (or that a
  CLI `subshell enroll` made behind the app's back). One address known is not a
  drift — an un-enrolled client has no `serverUrl`, a CLI-enrolled machine no
  stored `planeUrl` — so the notice stays silent there.
- **The node's plane address is shown in ONE place**,
  `components/node-plane-card.tsx`, and deliberately not as a `probe-facts`
  row: it is the only address on the page that can be changed, so it lives with
  the control that changes it, and the enroll-time loopback warning moved with
  it. A `probe-facts` test pins its absence.
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
- **The Linux tray may be silently invisible — so it is PROBED, not assumed.**
  `TrayIconEvent` is never emitted there, and the icon is drawn only where a
  StatusNotifier **host** is registered on the session bus (KDE yes, stock
  GNOME no until the AppIndicator extension). `crates/desktop-core/src/tray.rs`
  asks, by shelling out to
  `busctl --user get-property … IsStatusNotifierHostRegistered`, and every
  non-affirmative outcome — no bus, no watcher, no tool, a timeout — means "no
  tray". Close-to-tray defaults ON since 2026-09-07 (the tray-resident
  controller is the point of these apps) and the CLAMP, not the default, is
  what makes that safe on a tray-less desktop; `node_set_close_to_tray` refuses
  `true` where none answered; `node_settings` clamps the stored value on READ
  too; and the window-close handler **re-probes**, which is the guard that
  actually protects the user — the setting may have been made on a session that
  had a tray. The probe is deliberately not memoized for that reason, and the
  page draws the switch DISABLED with the reason plus a re-check (never hidden)
  when `trayStatus` is `not-detected`, because naming the extension is
  actionable and an absent control is not. It is a false negative on the older
  XEmbed tray, which is why every string says "none was detected".
- **The two apps' icons differ only by BACKGROUND COLOUR** (`brand/generate.ts`
  — plum here, near-black for the server), which is also why the tray icon is
  NOT `icon_as_template(true)` on macOS: a template icon is drawn from the alpha
  channel alone and both would collapse to the same filled square.
