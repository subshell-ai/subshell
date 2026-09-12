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
| `node` | `ui/dist/index.html`, from the bundle — the assistant | every `node_*` command |

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

**The node window is a FIXED 1024x720 assistant frame** (spec 2026-09-12 § 6.4),
non-resizable and centred, and the window-state plugin is DENYLISTED for it.
Both halves matter: the screens are drawn to that arithmetic, and the plugin
restores geometry after the builder sets it, so a saved size from the window's
resizable 760x720 era wins silently. `apps/server/desktop` found exactly this
by running its app (43f6682) and the fix is the same — denylist the label
rather than drop `StateFlags::SIZE`, because `main` shows a control plane's UI
and THAT window's size is a real user choice.

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
├── control.rs     the `node_*` commands, and Probe
├── reset.rs       the delete plan, the stashed consent, and the chain that honours it
├── windows.rs     the two windows — the plane's page, and the bundled node assistant
├── tray.rs        tray icon + menu (an explicit id; a Menu attached, or Linux may not register it;
│                  the close-to-tray CheckMenuItem lives here)
├── menu.rs        the macOS menu bar — module-gated, because Linux has none
└── lib.rs         plugins, environment scrubbing, lifecycle

ui/                the bundled page (React + Vite + Tailwind), built to ui/dist
├── src/lib/       ipc.ts (the typed command contract), node-assistant-state.ts (which
│                  screen this machine sees), probe-facts.ts, plane-coherence.ts, copy.ts
├── src/hooks/     the two queries, the serializing action runner, the commands
├── src/components/ui/   primitives copied from apps/server/web
├── src/components/assistant/   the frame and the six screens
└── src/components/      what the screens compose (enroll fields, the confirmation, the footer)
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

## The node page is an assistant

One screen at a time, each asking exactly one question, in the same frame
Subshell Server's setup assistant uses — so the two apps read as one product
(spec 2026-09-12 § 6.4). It was seven stacked cards that showed everything at
once and asked nothing in particular.

`lib/node-assistant-state.ts` holds the routing, pure: `screenFor(probe,
settings, override)` answers one of **connect**, **install-agent**, **enroll**,
**service**, **connected**, **reset**, and `screenTitle` names it. A plane
address comes FIRST, ahead of anything the probe says — without one this app
has nothing to show in its other window, and "enroll this machine" is a
question about a server nobody has named yet. Two screens are things a person
ASKS for rather than states a machine implies (re-enrol, reset); those arrive
as the `override`, which is why they are a separate argument rather than a
seventh probe step.

`app.tsx` is a host and nothing else: it reads the machine, holds the action
runner and the enroll form, and composes the shared half of the frame (title,
subtitle, the problem line, the confirmation, the footer). Each screen owns its
icon, its content and its bottom bar.

What the shape changed, and why:

- **Facts moved under "Show Details".** A person opens this window to DO
  something, not to read twelve fields. `lib/probe-facts.ts` is unchanged and
  still the only reader of the probe's shapes; only where it renders moved.
- **Stop and Uninstall left the app.** Restarting a node is a control-plane
  action now (spec 2026-09-12 § 6.3, `POST /api/nodes/:id/restart`), and
  removing the service is what Reset does. What survived is the one REMEDY the
  restart refusal names by label — rewriting a definition that would SIGKILL
  live panes — because the confirmation text points at that button.
- **"this Mac" comes from the USER AGENT, not the probe.** Unlike the server
  app's, this app's `Probe` carries no platform field, and adding one to reach
  a copy decision would be a Rust change for a string.
- **The About footer is ONE LINE** under the bottom bar. It still owns no
  strings — `node_about`, so the facts live only in
  `crates/desktop-core/src/legal.rs` — but the colophon it used to render
  competed with the one question each screen asks. It also sets
  `retryOnMount: false`: swapping screens remounts the footer, and a failed
  read of a compiled-in constant has nothing to retry for.

The rules ported from the Subshell Server console in 2026-09-08 are unchanged
by any of that:

- **Reveals name an intent, never a path.** `node_open_path` takes the closed
  `config-dir | data-dir | agent-log` enum; the Linux `agent-log` rejection IS
  the `journalctl` command, and the facts list also shows the log location (the
  CLI's `logPath` shape: a file on macOS, the journal sentence on Linux) so it
  is readable without clicking.
- **The plane's second door.** `node_open_plane_url` opens the settled control
  plane in the SYSTEM browser — for what the in-app window is wrong for (a
  different profile, a share, passkeys). The page passes NO URL: the command
  re-reads the same ladder `node_open_plane` points a window at. On the Connect
  screen it therefore has to PERSIST the typed address first and open the
  browser once that lands, because an address never saved cannot be re-read —
  and the action runner drops a concurrent submission, so the two cannot be
  fired together.
- **tmux is a gate, not a caption.** Enroll and the service verbs are disabled
  while the probe cannot find tmux — `enroll` refuses CLI-side and a tmux-less
  node comes up online with no harnesses, so a live button only manufactures
  the failure. The reveals and Refresh stay live (disabling those strands the
  box), the hint names the install command (`TMUX_INSTALL_CMD`), and the gate
  reads the CURRENT probe, so installing tmux and refreshing re-arms it.
- **The manager row says what the manager said.** `probe-facts` appends the
  service `detail` verbatim (`launchd: spawn scheduled` is the crash-throttle
  wait) and paints `state: unknown` bad — a manager that would not answer is
  not the same fact as a stopped agent.

## The tray preference is in the tray

`close_to_tray` is a `CheckMenuItem` in the tray menu, and `node_settings` no
longer carries it. The preference is ABOUT the tray, so it belongs there — and
putting it there REMOVED two commands (`node_set_close_to_tray` and the
settings payload's tray trio) rather than moving them to a screen that now asks
one question at a time.

Two properties, neither re-derived here: muda flips the item's own state BEFORE
the menu event fires, so the handler reads the item rather than toggling a
stored copy (two places deciding what "checked" means is how a menu disagrees
with itself), and `is_checked()` from a menu handler does not deadlock. Both
were measured against muda 0.19.3 on the macOS and GTK backends by
`apps/server/desktop`'s own check item.

**The clamp is what makes the ON default safe**, and it survives the move
intact: `close_to_tray_now` is what the check item seeds from and what the
window-close handler reads, so a desktop with no StatusNotifier host cannot
hide a window into an icon nothing draws. The item shows the CLAMPED value,
because a check mark claiming behaviour the app will not honour is a check mark
that lies.

## Reset — returning this machine to un-enrolled

`src-tauri/src/reset.rs`, and the shape is `apps/server/desktop`'s deliberately:
**the page supplies a hostname, never a path.**

`node_arm_reset` reads the machine NOW and stashes a delete plan parsed from the
agent's own `subshell status --json` `paths` block; `node_reset` deletes exactly
that, gated on the typed hostname. The plan is stashed at press time rather than
re-read inside the chain because the chain UNINSTALLS the very agent whose
report names those paths — re-reading afterwards would be asking a removed
binary where its own data lived.

- **All-or-nothing.** Every one of `configFile`, `lockFile`, `dataDir` present,
  non-empty and absolute, or there is no plan. A status with no `paths` key at
  all is the not-enrolled case (the CLI omits the block when no config loaded),
  and the screen renders its own refusal rather than offering a button.
- **config.json is deleted LAST.** It is what makes this machine a node, so
  while it survives the reset is resumable: a half-run that died after the data
  dir still has the config the next attempt reads its plan from. `deletion_order`
  is a pure function returning a `Vec<PathBuf>` precisely so that property is a
  test rather than something only a real wipe would show.
- **The guards are the shared ones** in `subshell_desktop_core::reset_guards`:
  `path_rules_ok`, `delete_guard_ok`, `is_subshell_socket`, `consent_granted`,
  and `machine_hostname` — which moved there in 2026-09-12 when this chain
  needed it, because it is the value `consent_granted` compares against and two
  copies of a fail-closed rule is one copy that can drift open.
- **The probe reports the hostname so the screen can SHOW it.** The gate is
  deliberate consent, not a memory test, and a box demanding a string the page
  cannot display would be both. An empty memo (hostname(1) would not run) is
  refused by name — the empty box it would otherwise match is the one thing
  this gate may never accept.
- **Three paths, not the server's five, and NO window dance.** That app has one
  manage window and a zero-window moment quits it; resetting a node here
  invalidates neither of this app's windows, and the page's own re-probe lands
  it on Enroll.
- **`planeUrl` is KEPT.** The control plane this person watches is not what they
  reset; making them retype its address to get their dashboard back would be
  the reset reaching past what it promised.
- **Channel discipline:** `Err` only for refusals BEFORE the first mutation. A
  half-run is `Ok(ActionResult { ok: false })` with the verbatim log and the
  plan still stashed, so a Retry converges.

What it deliberately does not reach is on the screen, because each is something
a person would assume it handled: the control plane keeps a node row (now
permanently offline, for its owner to delete there), the installed
`~/.local/bin/subshell` stays (the containment guard refuses any delete that
would take it), and a Subshell Server on the same machine is untouched.

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
  `node_configure` now writes BOTH, and `lib/plane-coherence.ts` names the pairs
  that predate it (or that a CLI `subshell enroll` made behind the app's back).
  One address known is not a drift — an un-enrolled client has no `serverUrl`, a
  CLI-enrolled machine no stored `planeUrl` — so the notice stays silent there.
- **Both addresses are shown in ONE place**, the connected screen's **More…**,
  and deliberately not as `probe-facts` rows: they are the only addresses on
  the page that can be CHANGED, so they live with the controls that change
  them — and they sit adjacent because the whole point is that they can
  disagree. The enroll-time loopback warning is there with them. A
  `probe-facts` test pins the node address's absence from the facts list.
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
