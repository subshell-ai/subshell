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

**Styling follows `docs/design-system.md`** — six type roles, two weights,
shadcn colour names — and `bun run lint:design` fails on a literal size,
weight or colour outside the token file. Pick a role, never a number.

## Two windows, and why that is the whole design

| window | page | granted |
|---|---|---|
| `main` | the control plane's own UI, at the plane's origin | **one command**: `desktop_open_in_browser` |
| `node` | `ui/dist/index.html`, from the bundle — the assistant | every `node_*` command |

`main` loads the plane's own page rather than a bundled copy because
`apps/server/web` is hard same-origin — relative `apiFetch` with
`credentials: "include"`, an auth client with no `baseURL`, a WebSocket URL
built from `window.location.host` — so a `tauri://` page could not carry the
`SameSite=Lax` session cookie to any of them.

**`capabilities/main.json` grants that window ONE command, and the narrowness
is in the ARGUMENT rather than in the scope.** `apps/server/desktop` can pin
its remote window to loopback because it manages the server serving it; a
control plane can live on any host, so there is no equivalent pin here. The
capability's `remote.urls` is therefore a WILDCARD (`http://*:*`,
`https://*:*` — `http://*` alone does not match a non-default port in the
`urlpattern` crate Tauri 2.11.5 uses, which would silently exclude the default
`:3080` plane), and the command is what has to be safe.

Until 2026-09-14 that file did not exist, and the ABSENCE was the boundary.
That was right while a plane's page had nothing useful to ask for. "Open in
browser" is useful: a webview has no address bar and no second tab, and the
page a person wants in their real browser — with their profiles, their password
manager, their extensions — is the one they are looking at.

- **`desktop_open_in_browser` takes a PATH.** It must start with `/`, must not
  start with `//` (protocol-relative names a HOST), and may contain no `://`,
  no backslash (`\` is `/` to the WHATWG URL parser, so `/\evil.test` is the
  same attack in another spelling), no whitespace and no control characters.
  The rule and its tests are `crates/desktop-core`'s `browser` module, shared
  with the other app so the two cannot disagree about what a path is. The
  ORIGIN comes from `PlanePin` — the same value `on_navigation` enforces — so
  the page names the route and Rust names the host. The worst an XSS in a
  plane's SPA gains is opening a page of that same plane, which the person can
  do by typing the address.
- **Nothing else.** No `node_*` verb, no plugin permission, no `core:default`;
  `ui/src/__tests__/ipc-acl.test.ts` pins the scope, pins the permission list
  at one entry, asserts every other manifest permission is the bundled page's,
  and pins the Rust signature at `(app, path)`.
- **A `SubshellClient/…` user-agent marker, new and paired with that grant.**
  The marker is how `apps/server/web` decides it is in a desktop shell and
  starts talking to Tauri; it was deliberately absent while nothing was
  granted, because every call it invited would have been refused one at a time.
  The SPA branches on the PRODUCT TOKEN now: `isServerDesktop()` gates Subshell
  Server's chrome (overlay title bar, update, reset, supervision, native
  notifications) and is false here, while `isDesktop()` gates only the two
  "Open in browser" surfaces — the sidebar row and a subshell's actions menu.
  So there is still no `shell_ready` handshake and no `bridge.rs` CustomEvent
  bus here: this window's whole Tauri surface is one command.
  `withGlobalTauri` is `true` for the same reason (see below).
- **What IS kept:** an `on_navigation` origin pin, `disable_drag_drop_handler`
  (Tauri's native file-drop handler otherwise swallows the HTML5 drags behind
  drag-a-subshell-into-a-workspace and the terminal's uploads), and a 360x240
  minimum size — a third of the SPA's 1024px tiling breakpoint, so the window
  can be parked in a corner and renders the SPA's narrow chrome when it is.

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
halves to disagree about.

**Every launch lands on the node window, settled address or not** (spec
2026-09-18). `open_at_startup` opens it unconditionally, and
`startup_leads_with_node` is the rule written down in one place with its own
test. Until 2026-09-18 a stored `planeUrl` (else the enrolled node's own
`serverUrl`) made the DASHBOARD lead, which is the defect the first-run work
removed: pressing the one button on a fresh install threw the plane's window on
screen while the setup carried on in the window behind it. A client never opens
the control plane's dashboard by itself now — a configured client lands on its
own client-status screen and the dashboard opens from the button there.

**It must always have a route home, and the tray is not one.** The plane window
is remote content whose one grant opens a browser, so it cannot offer a way
back into this app, and a tray
icon is silently invisible wherever no StatusNotifier host is registered. So:
macOS gets **Window → This machine…** in the menu bar (always drawn, which also
covers the notched-display hazard in `tray.rs`); everywhere else,
`node_window_has_a_route_home()` asks `desktop-core`'s tray probe and, when the
answer is no, `focus_any` RE-CREATES the node window — so relaunching, which is
what `tray.rs` calls the way back from an invisible tray, actually is one.
`open_at_startup` no longer consults that probe, and does not need to: it opens
the node window on every desktop, which is strictly more than the check ever
bought. `focus_any` is the path where that window can genuinely be GONE, so the
probe survives exactly there.

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
  runtime permission rejection, not a compile error. The same file asserts what
  the `main` window holds — one permission, one scope, one Rust signature.
- **`withGlobalTauri` is `true`, and it is the OTHER window that needs it.**
  This page imports `invoke` from `@tauri-apps/api/core` and has no use for a
  global; it was `false` from the day that import landed. What changed on
  2026-09-14 is that the plane's window has something to invoke, and
  `apps/server/web`'s bridge (`src/lib/desktop.ts`) reads `window.__TAURI__`
  and imports nothing by design — it must not pull `@tauri-apps/api` into a
  bundle served to browsers, and the repo forbids the dynamic import that would
  avoid that. The global GRANTS nothing; `capabilities/main.json` does. Turning
  it back off would not close a hole, it would make that one command silently
  unreachable — the bridge never throws, which is exactly the failure
  `apps/server/desktop` measured on 2026-09-10 when its config was copied from
  this one. `ui/src/__tests__/tauri-config.test.ts` pins the PAIR: while
  `windows.rs` ships a marker, the global must exist.
- **Design tokens and the `components/ui/` primitives are COPIED** from
  `apps/server/web`, verbatim except the `cn` import path. Copied rather than
  shared so extracting them into a package later is a straight move, and so a
  diff between the two copies is the drift signal.

## Native prerequisites

**`bun install` covers none of these, and the root README no longer keeps a
prerequisites list** — this section is the list. Every workflow that builds this app runs INSIDE
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
├── src/components/assistant/   the frame and the screens (NodeScreenId)
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

## Installing the bundled agent is a TRANSACTION, not a copy

**`node_install_agent` has two paths, and the split is whether there is an
installed CLI to ask** (spec 2026-09-15 § 7.1):

- **A REPLACE of the managed copy** (`probe.managed` — the binary this machine
  actually runs IS `~/.local/bin/subshell`) runs
  `<installed> update --from <staged sidecar> --yes --no-restart --json`. The
  agent has no database, so this buys less than it does on the server side:
  `<binary>.previous`, the `update-pending.json` marker, and the version probe
  that refuses a file which cannot say what it is. It is still the same code
  on every path, which is the point.
- **A first install** keeps `sidecar::install_bundled`: there is no installed
  CLI to run.

Two things went away with the stop, and neither was a loss:

- **The service is no longer stopped**, so `stop_note` and `with_stop_output`
  are gone. They existed because `install_bundled` writes the file the daemon
  is executing; the CLI's swap is a `rename(2)` a running daemon does not
  notice, so there is nothing left for them to warn about. The deliberate
  no-restart is unchanged — `--no-restart` says it, and the screen still tells
  the person to start it.
- **The flags are a CONTRACT, held in one place.**
  `desktop-core`'s `cli_update::update_args` spells them for both apps, and its
  tests pin the exact list; `update_argv` here is pinned against it, so this
  app can never spell one of them itself.

**An agent older than the verb falls back to the plain copy, and SAYS so.**
Every `subshell` agent that existed on 2026-09-15 predates `update` — 0.8.0 was
cut before it was written — so without a fallback the app's offer would fail
with a usage dump on exactly the upgrade it exists for. The fallback is
`install_bundled`, the same `rename(2)` swap this path used before, and the
screen carries `legacy_install_summary`'s sentence: *Installed 0.9.0 over
0.8.0. No rollback point was recorded: the previous agent predates the update
command, so this install cannot be undone automatically.*

**It claims no missing DATABASE backup, unlike the server app's.** The agent
has none, and its own `update` takes none either — so naming one would alarm
about something that was never going to happen, which is the defect
`RESET_LABEL`'s history documents at length. What this install really loses is
`<binary>.previous`, so that is what the sentence names
(`cli_update::Unrecorded::Rollback`).

**What makes the fallback safe is how NARROW the detection is.**
`cli_update::lacks_update_verb` requires the run to have finished, to have
failed, and to carry `unknown command 'update'` in its own output. It keys on
that MARKER rather than an exit code because the two CLIs disagree —
`node-v0.8.0` routes usage errors through `fail(2, UsageError)` and exits **2**
where `server-v0.6.0` exits **1**, both measured at the tags — so a number
pinned here would have silently excluded one app. Every other failure stays a
failure: falling back on a pane-safety refusal or a version mismatch would
leave no `.previous` while reporting success.

## Updating the app itself

`src-tauri/src/app_update.rs` and the `app-update` screen — a near-twin of
`apps/server/desktop`'s, which documents the design once; read it there. What
differs here is only what is `tauri`-typed: the tag prefix
(`desktop-client-v`), the progress event (`node-app-update-progress`), the two
command names (`node_check_app_update` / `node_install_app_update`, both
`node`-window-only), and the screen, which is a React component rather than a
DOM render. Everything with no `tauri` type in it — the endpoint, the tag
parse, the semver pick, the manifest URL, the 24-hour schedule — is
`desktop-core`'s `release_feed`, shared.

Two facts specific to this app:

- **The node agent is NOT touched by an app update.** Replacing this app
  replaces the agent it BUNDLES, which is a source to install FROM and is on
  no rung of the resolution ladder — so a running `subshell` daemon keeps
  running `~/.local/bin/subshell` until someone presses Update on the
  Connected screen. The screen says so.
- **The signing key is the SAME one `apps/server/desktop` pins**, because the
  two apps are one publisher and a public key is the publisher's identity
  rather than the app's. One `bunx @tauri-apps/cli signer generate -w
  ~/.tauri/subshell-desktop.key`, the `.pub` contents committed as
  `plugins.updater.pubkey` in BOTH `tauri.conf.json` files, and two repo
  secrets: `TAURI_SIGNING_PRIVATE_KEY` (the key file's **CONTENTS**, not a
  path — measured 2026-09-15, tauri 2.11 ignores the `_PATH` spelling) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. **The `.key` in your password manager
  IS the backup, and losing it means every already-installed app can never
  auto-update again** — a new key is a new publisher to those installs, and
  the only way back is a hand download.

Local cost, same as the other app: because the pubkey is configured and
`bundle.createUpdaterArtifacts` is on, **`bun run compile` needs
`TAURI_SIGNING_PRIVATE_KEY` set**. `tauri dev` bundles nothing and is
unaffected.

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

**Two commands arrived with the first run** (spec 2026-09-18), both granted to
the `node` window alone:

- **`node_install_tmux`** installs tmux, so this app can offer what Subshell
  Server always could. The table it runs is `crates/desktop-core`'s
  `tmux::install_argv` — SHARED with the server rather than copied, which is
  why the argv lives in the crate and not here: brew on macOS (nothing
  runnable without it), `pkexec apt-get` on Linux (never a bare `sudo`, which
  from a GUI has no tty and hangs to the timeout). The install is streamed
  through a `LineSink`; this app passes a no-op one, because its tmux screen
  listens for nothing and an event name with no listener is a dangling half of
  a contract.
- **`node_set_plane`** remembers a control plane WITHOUT opening its window.
  It exists because `node_open_plane` does both, and the first run's connect
  step must do only the first — a dashboard that appears mid-setup is the
  defect that whole flow removed. The dashboard opens from the status screen's
  own button afterwards.

`node_service` also gained `autostart` beside `force` — `false` spells
`--no-autostart`, the flag the node agent gained on the same day. The Rust side
refuses to pass it on any verb but `install`, exactly as it refuses `--force`
anywhere but `restart`: the CLI's flag allowlists are per-subcommand, so the
wrong pairing is a usage error rather than a no-op.

## The node page is an assistant

One screen at a time, each asking exactly one question, in the same frame
Subshell Server's setup assistant uses — so the two apps read as one product
(spec 2026-09-12 § 6.4). It was seven stacked cards that showed everything at
once and asked nothing in particular.

**The routing is `lib/client-flow.ts`, and `screenFor` is gone** (spec
2026-09-18). It answered "which screen does this machine imply", and the first
run needs the question that comes BEFORE that one: what did this person come
to do. `clientScreen({probe, settings, step, override})` answers both, in that
order — nothing read yet ⇒ `null`; a screen the user asked for; the in-memory
walk (`FteStep`), which outranks the next rule because enrolling settles an
address mid-chain; a CONFIGURED client ⇒ **status**; a half-built machine ⇒
**register**; otherwise **welcome**. `lib/node-assistant-state.ts` keeps the
vocabulary — `NodeScreenId`, `screenTitle`, `serviceAction` — and no longer
decides anything. There is ONE router, deliberately: two functions answering
"which screen" is how they come to disagree.

Three screen ids went with it, and their absence is the design.
**`connected`**, **`service`** and **`install-agent`** were the probe-derived
landings; every configured client lands on `status` now, which carries what
each of them offered — the contextual service verb, the pane-safety rewrite,
the config and agent-log reveals, and the split that decides whether
registering may be offered at all (below). A screen nothing can
route to is not a recovery path; it is dead code that reads like one.

An address no longer comes first, either, and that reversal is load-bearing:
`configured()` counts an ENROLLED machine as well as a stored `planeUrl`,
because the walk ends at Register and Register on a node mints a second node
row and discards its node key. Two screens are still things a person ASKS for
rather than states a machine implies (re-enrol, reset, plus about and
app-update); those arrive as the `override`.

**`no-agent` reads two ways, and status must keep them apart.** The Rust side
folds "nothing on the ladder answered" and "a binary answered `version` but not
`status --json`" into one step on purpose (control.rs says why). Where nothing
answered, installing is safe unconfirmed and is offered ON ITS OWN — not folded
into Register, because a machine with no agent cannot say whether it is already
a node and the register chain enrols with `confirm: true`. Where a binary
answered but could not report, NOTHING is offered: the remedy is a different
binary. Registering is also withheld over a probe that could not be read at all
and over a step this build predates. That was `install-agent-screen.tsx`'s whole
reason for existing; it is `status-screen.tsx`'s now.

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
- **There is ONE word for where you are, on both platforms** (operator's call,
  2026-09-12): "This Machine" in a title, "this machine" mid-sentence. The
  `darwin ? "this Mac"` split is gone from titles AND subtitles, and
  `screenTitle`/`subtitleFor` take no platform argument at all. The macOS feel
  this assistant is after comes from its SHAPE — one decision per full-window
  screen, fixed bar positions, screens that ask nothing never appearing — not
  from its vocabulary, and the split cost a branch, a test matrix on every
  string, and one real misreading: a label ending on "Mac" is a prefix of the
  other platform's own word and was reported as a truncated layout bug. A
  genuine platform FACT still branches — which tmux installer to name
  (`TMUX_INSTALL_CMD`), launchd versus systemd — because that is a difference
  in what the user must do, not in voice.
- **The About footer is ONE LINE** under the bottom bar. It still owns no
  strings — `node_about`, so the facts live only in
  `crates/desktop-core/src/legal.rs` — but the colophon it used to render
  competed with the one question each screen asks. It also sets
  `retryOnMount: false`: swapping screens remounts the footer, and a failed
  read of a compiled-in constant has nothing to retry for.

The rules ported from the Subshell Server console in 2026-09-08 are unchanged
by any of that:

- **Reveals name an intent, never a path.** `node_open_path` takes the closed
  `config-dir | data-dir | agent-log` enum; an `agent-log` rejection IS the
  remedy (the path it will appear at, plus the `journalctl` command on Linux),
  and the facts list also shows the log location so it is readable without
  clicking.
- **`agent-log` resolves the agent's OWN capped file first**, on every
  platform (2026-09-18) — `~/.config/subshell/logs/agent.log`, the same
  JSON-lines file the plane's node log view serves, so revealing a log here
  and reading one in a browser cannot land on two different documents. That is
  the order `apps/server/desktop`'s `desktop_logs` reads the server's log in,
  for the same reason. The service manager's redirect is the FALLBACK and a
  genuinely different artifact: `~/Library/Logs/subshell.log` holds the raw
  stdout of an agent that died before opening its own file (Linux has no such
  file — the unit redirects nothing, so the fallback is the journal sentence).
  A rung counts only when it has CONTENT, not merely when it exists, because
  the capped writer truncates to zero and starts over — the same rule
  `server_log_tail` follows. `agent_log_from` takes its two roots and a
  content predicate so the ORDER is tested without a machine in a particular
  state.
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

## Text size is Rust's, not the page's

⌘+ / ⌘− / ⌘0 (View, on macOS) and the tray's **Text Size** submenu walk a fixed
ladder — `0.8 · 0.9 · 1.0 · 1.1 · 1.25 · 1.5 · 1.75 · 2.0` — stored as `zoom` in
this app's own `settings.json` and applied with `WebviewWindow::set_zoom`. The
ladder, the clamp and the frame arithmetic are `desktop-core`'s `zoom` module;
`src/zoom.rs` here is the level, the menu ids and the apply.

**Tauri's own `zoom_hotkeys_enabled` was rejected, and the reason is the trust
boundary.** On macOS and Linux it injects a page script that invokes
`plugin:webview|set_webview_zoom`, so it works only on a window granted that
command — and this app's `main` window is granted exactly one, which opens a browser rather than resizing anything, since a control plane's origin cannot be enumerated ahead of time and the grant there has to stay argument-narrow. It also keeps its level in a page-local variable, which a
reload resets. `set_zoom` called from Rust touches no ACL at all.

**Both menus' items share one id set, and it is routed in exactly one place** —
`lib.rs`'s app-level `on_menu_event`, registered on every platform. A Tauri
menu event is GLOBAL: that handler receives the tray's items and the tray's
handler receives the menu bar's, so an id matched in both steps the ladder
twice per click. Measured on 2026-09-12 by clicking Bigger twice and landing on
1.75.

Three things follow, each with a failure that is invisible from reading the
diff:

- **The level is clamped on READ** (`clamp_zoom`), the way `close_to_tray` is.
  `settings.json` is a file a person can edit, and a `0` in it is a window
  nobody can read well enough to fix from inside the app. Clamping SNAPS onto
  the ladder, which is what lets a step always land on a rung.
- **The SPA's floor scales with the level.** The floor is a promise about the
  VIEWPORT and zoom is what divides physical pixels into CSS pixels, so at 150%
  an unscaled 360px window would lay out in 240 CSS pixels — narrower than
  anything the SPA is drawn for. Scaling it keeps the promise at every rung.
- **The assistant frame scales too, clamped to the work area.** It is fixed and
  non-resizable, so bigger text in an unchanged frame is just less room to say
  the same thing. The clamp is the same one `wizard_height` always was — a
  non-resizable window whose bottom edge is past the work area takes the bar
  carrying Continue with it. Content that overflows the frame is the safe case:
  the bar is its own row and the region above it scrolls.

**Linux has only the tray**, because a GTK menu bar is per-window chrome rather
than a system bar. Where the tray probe says no icon would be drawn, there is
no route to the text size at all; the fix if that ever bites is one row on the
bundled assistant page, which is the surface that can already invoke commands.

## About is a screen you ask for, not a footer

The node assistant used to carry a one-line colophon under its bottom bar on
every screen. It is gone (operator's call, 2026-09-12): the assistant asks one
question per screen, and a line about who owns the product read as part of that
question.

What replaced it is `components/assistant/about-screen.tsx`, one of the
`NodeUserScreen` overrides beside `enroll` and `reset` — screens a PERSON asks
for, which no probe ever implies. The routes to it:

- **macOS**: the system's own About panel, which `menu.rs` already built from
  the same constants. Unchanged.
- **Everywhere**: the tray's `About Subshell Client`, which raises the node
  window and emits `desktop-screen` to THAT window alone (`windows::show_node_screen`).
  A broadcast would also reach the plane's page, which this app tells nothing
  and tells nothing. A screen id this build does not know is ignored rather
  than being an error, so a menu item and the page can ship independently.

**The emit fires on "a page is LISTENING", never on "a window exists".** The
request is stashed first and a booting page PULLS it (`node_pending_screen`),
because a window's existence is true the moment the builder returns and a
`listen()` registers over IPC well after that — Tauri queues nothing in
between. `PendingScreen.listening` is the flag that tells the two apart: the
pull sets it, building a window clears it, and only a set flag takes the emit
path. Window existence was the proxy here until 2026-09-12, and two About
clicks in quick succession were enough to lose the second one entirely — the
same defect `apps/server/desktop`'s reset screen was reported for.

The content still comes from one `node_about` call, so the facts live only in
`crates/desktop-core/src/legal.rs`, which `scripts/license-fields.ts` holds
equal to the TypeScript copy and to the root LICENSE. The AGENT's version comes
from the probe instead — a different program's version, and the pair is what a
person opens an About for.

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
- **Both addresses are shown in ONE place**, the STATUS screen's **More…**
  (the connected screen's, until that screen was subsumed on 2026-09-18),
  and deliberately not as `probe-facts` rows: they are the only addresses on
  the page that can be CHANGED, so they live with the controls that change
  them — and they sit adjacent because the whole point is that they can
  disagree. The enroll-time loopback warning is there with them. A
  `probe-facts` test pins the node address's absence from the facts list.
- **A setup key is single-use and lasts 24 hours.** Everything checkable is
  checked before the server consumes it, but a 409 (name already taken) or a 500
  arrives AFTER — and spends it. Those say "mint a new key", never "retry".
  What is NOT spent is a retry's name: `clearSpentKey` clears the credential and
  LEAVES the name, because the next attempt is usually the same machine with a
  fresh key, and wiping a field the operator typed to make them retype it is a
  tax on the wrong thing.
- **The Enroll step's name is REQUIRED, in all three of its spellings.** The
  dialog's field label, `validateEnroll` (TS) and `validate_node_name` (Rust,
  which spawns `--name` unconditionally now that `subshell enroll` refuses
  without it). It is the same question `subshell setup` asks on a terminal, asked
  here instead because this app hands the CLI arguments rather than a keyboard:
  `AgentCommand::Enroll` carries `name: String`, so a nameless enroll is not
  representable. What the control plane stores is `normalizeNodeName`'s output —
  imported from `@internal/subshell-protocol` rather than re-implemented here —
  so a pasted name cannot be clean in this app and collapsed only at the server.
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
