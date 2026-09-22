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
server's Nodes page lists it, and the sidecar stem names the node it wraps.

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
  ORIGIN comes from `PlanePin` — the origin this window was OPENED with, which
  is no longer what `on_navigation` enforces (it follows any http(s) URL since
  2026-09-18, so a plane behind an OAuth proxy can complete its sign-in). That
  is precisely why the command reads the pin rather than the page: a page
  anywhere a redirect leads can still only open a path of the plane this window
  opened with. So
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
- **What IS kept:** an `on_navigation` SCHEME refusal (the origin pin went on
  2026-09-18 — see above; the window follows http(s) so a proxied sign-in
  works, and non-http(s) is still refused so it cannot be steered into
  anything the OS would act on), `disable_drag_drop_handler`
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
node — which is exactly the file this app has to be able to tell apart from
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
├── node_bin.rs   the resolution ladder for `subshell`, and the bundled-vs-installed policy
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

## Installing the bundled node is a TRANSACTION, not a copy

**`node_install_cli` has two paths, and the split is whether there is an
installed CLI to ask** (spec 2026-09-15 § 7.1):

- **A REPLACE of the managed copy** (`probe.managed` — the binary this machine
  actually runs IS `~/.local/bin/subshell`) runs
  `<installed> update --from <staged sidecar> --yes --no-restart --json`. The
  node has no database, so this buys less than it does on the server side:
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
  no-restart is unchanged — `--no-restart` says it — and since spec 2026-09-18
  § 7.1 the screen OFFERS the restart rather than telling the person to start
  something that was never stopped. `rename(2)` leaves the running process on
  its original inode, so after a successful install the file is the new node
  and the daemon is the old one, and nothing on screen used to say so.
- **`node_install_cli` also settles the update marker.** It counts an
  attempt before the install and drops the marker after one that succeeded, so
  every route into the node half — the resumed act, the Retry the screen
  offers once it has halted, and the status screen's own door — is bounded and
  finishing by the same code. An attempt is an attempt whoever asked for it.
- **The flags are a CONTRACT, held in one place.**
  `desktop-core`'s `cli_update::update_args` spells them for both apps, and its
  tests pin the exact list; `update_argv` here is pinned against it, so this
  app can never spell one of them itself.

**A node older than the verb falls back to the plain copy, and SAYS so.**
Every `subshell` node that existed on 2026-09-15 predates `update` — 0.8.0 was
cut before it was written — so without a fallback the app's offer would fail
with a usage dump on exactly the upgrade it exists for. The fallback is
`install_bundled`, the same `rename(2)` swap this path used before, and the
screen carries `legacy_install_summary`'s sentence: *Installed 0.9.0 over
0.8.0. No rollback point was recorded: the previous node predates the update
command, so this install cannot be undone automatically.*

**It claims no missing DATABASE backup, unlike the server app's.** The node
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

`src-tauri/src/app_update.rs` and the `update` screen — a near-twin of
`apps/server/desktop`'s, which documents the design once; read it there. What
differs here is only what is `tauri`-typed: the tag prefix
(`desktop-client-v`), the progress event (`node-app-update-progress`), the two
command names (`node_check_app_update` / `node_install_app_update`, both
`node`-window-only), and the screen, which is a React component rather than a
DOM render. Everything with no `tauri` type in it — the endpoint, the tag
parse, the semver pick, the manifest URL, the 24-hour schedule — is
`desktop-core`'s `release_feed`, shared.

Two facts specific to this app:

- **The node CLI is NOT touched by the app install itself**, which is why
  the act has a second half. Replacing this app replaces the node it BUNDLES,
  which is a source to install FROM and is on no rung of the resolution ladder
  — so a running `subshell` daemon keeps running `~/.local/bin/subshell`
  whatever lands. See "Updating is one act" below for what finishes it.
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

## Updating is ONE act, in two phases

Spec `docs/superpowers/specs/2026-09-18-one-update-act-design.md`. **This app
SHIPS the node it drives** — every desktop bundle carries the CLI it wraps
(root `AGENTS.md`) — so "update Subshell Client" and "update the node CLI"
were never independent: the second is the tail of the first. Until 2026-09-18
they were two screens with two buttons whose names differed by a possessive,
and the pair produced a loop that reads as a bug: update the app, and the next
launch's probe sees a bundled node newer than the installed one and asks
again.

There is one screen now, id **`update`** (`components/assistant/update-screen.tsx`,
replacing `app-update-screen.tsx`). `app-update` is DELETED from `NodeScreenId`
rather than aliased — this product has no installed base to keep compatible —
so the tray emits `"update"` and an id this build does not know is ignored, as
it always was. The status screen's **"Update the node to X"** stays where it
is, because that is the natural place to notice the node is behind, but it is
a DOOR to this screen rather than a standalone install (§ 7.4). Beside it sits
**"Check for updates…"**, the same door for a machine that knows of nothing
behind — and it is HIDDEN while the first one shows, because two adjacent
buttons opening one screen under two names is the defect § 1 exists to
remove.

**The two phases are separated by the relaunch, and the marker is what crosses
it.** `node_install_app_update` writes `pending_bundled_install` into this
app's `settings.json` AFTER the install and BEFORE `app.restart()` — never
after, because a crash between the two must leave a machine that knows what it
was doing. The new build reads it back, and four things about how are worth
holding:

- **The decision is shared, the acting is not.** `desktop-core`'s
  `resume_decision(marker, bundled, installed)` answers install / clear / halt
  for both apps; Subshell Server then installs and restarts its service, this
  app installs and OFFERS the restart. The marker converts an offer into a
  continuation and nothing more — whether work EXISTS is still the machine's
  answer, so a marker whose work was done by a hand `subshell update` in
  between is cleared without acting.
- **It rides the PROBE** (`Probe.pendingInstall`, built by `control::resume_view`),
  which is what let the whole thing ship with **no new Tauri command and no
  capability change**. `node_probe` already computes the bundled version
  against the installed one, which is exactly the pair the decision weighs, and
  the page already reads it every few seconds.
- **`node_install_cli` counts and clears.** An attempt is counted before the
  install, the marker dropped after one that succeeded, so the resumed act, the
  Retry, and the status screen's door are all bounded and finishing by one
  piece of code. `MAX_RESUME_ATTEMPTS` is 2: at the limit the marker STAYS —
  the screen still names the update and offers Retry — and only the automatic
  firing stops. That is the one place this design refuses to keep trying on
  someone's behalf.
- **`forced` never crosses into this app.** It is the marker's pane-safety
  consent for a service RESTART, and phase 2 here restarts nothing. A test
  pins that it is absent from what the page is told.

**The wire names are Subshell Server's, and the two divergences that remain are
STRUCTURAL.** `PendingInstall`, `pendingInstall` and `halted` are that app's
spellings, adopted here on 2026-09-18 (this app said `PendingUpdateView`,
`pendingUpdate` and `exhausted`) so a diff of the two update screens shows a
difference in design rather than in vocabulary — they are read side by side
whenever either changes. `attempts` is the field this app had first, and its
rule is now the shared one: **an attempt is counted at the FIRE**, in
`node_install_cli`, because an attempt is an attempt whoever asked for it.
`forced` stays the server's alone, per the bullet above. What genuinely differs:

- **Who raises the screen.** This app does it IN THE WEBVIEW (`app.tsx`, the
  `raisedUpdate` effect: the first probe carrying a marker sets the `update`
  override, once per launch); Subshell Server raises its own in Rust at boot.
  Ours is sound only because **`windows.rs`'s `open_at_startup` opens the node
  window unconditionally** — the webview that reads the probe is guaranteed to
  exist on every launch. That dependency is load-bearing and it is the whole
  reason no Rust-side raise was needed: make the node window conditional again
  and a relaunched update would sit unfinished behind a window nobody opened.
- **Who clears a done marker.** `resume_view` clears it HERE, on the poll that
  noticed — the one write that function makes. The server app's `resume_view`
  is read-only and its boot path does the clearing, which it can be because it
  has a boot path that runs. Nothing of ours runs at boot, so the read the page
  already makes is the only place that can notice.

**Phase 2 ends by OFFERING the restart** (§ 7.1), through the existing
`commands.restart()` — which already surfaces the CLI's verbatim refusal,
offers `--force` behind it and points at *Rewrite the service definition*. The
pane-safety sentence lives THERE and not on the install: the swap is a
`rename(2)` a running daemon never notices, so nothing about installing an
node can close a subshell, while the restart can. Whether to offer it is page
state (`installedNodeHere`), the `ranSetupHere` pattern, because the running
daemon's version is not something any probe here can read.

One shape in `update-screen.tsx` is a fix for a measured defect rather than a
style: the press records the `runner.output` it saw, and a verdict is read only
once a DIFFERENT one arrives. `runner.run`'s `isPending` does not land in the
same commit as the press, so an effect guarded on `busy` alone ran once with
the previous action's output still in place — and read the node install's
success as the restart's, retiring the offer nobody had taken.

**It is a SELECTION, not always both halves** (§ 13, 2026-09-18). One act is a
simplification exactly while the two halves point the same way; when they
diverge it is a claim about the machine that is wrong. They diverge whenever
somebody installs a `subshell` by hand that is NEWER than the one this bundle
ships: `decide_node` ADOPTS it (it never downgrades), so phase 2 would answer
`Resume::Clear` and install nothing — while the screen named that newer version
as a target it would be replaced by, and the press promised the install
underneath it. Reported against Subshell Server; identical here.

So the screen is a table — component, what it runs, what it would become, and a
checkbox where there is something to do. Four rules, each closing one of the
defects above:

- **The table is all-or-nothing.** Where nothing is in question there are no
  rows at all — that is this app's "everything is current", and what
  `upToDate` and `settled` read — and where anything is, BOTH components are
  stated. Asked as two separate gates it could drop a component from a table
  its sibling had opened (review, 2026-09-18): an air-gapped check beside a
  current node said nothing about the node, a current app beside a behind
  node said nothing about the app. Subshell Server states both rows
  unconditionally because it has no empty-table state to protect; this is the
  same rule with one.
- **A row with an available act carries a checkbox, ticked by default**, so
  both halves behind is still ONE press. That default is D1 unchanged.
- **A row with no available act states WHY where its checkbox would be** —
  *runs another binary*, *you run a newer one*, *this build does not say which
  node it ships*, *up to date*, *cannot be checked* — and **never a disabled
  checkbox**, which says "not now" without saying anything. (*installs with the
  app* was one of these until 2026-09-18; that row is a checkbox now, and its
  target cell is what says so.)
- **Both halves are checkboxes, on either footing.** Under an app press the
  node half is that act's TAIL — the node that lands is the NEW bundle's,
  whose version this build cannot know, so the cell reads "ships with the new
  app" rather than a number — but it is still a choice: clearing it makes
  `node_install_app_update(install_node: false)` write NO marker, so phase 2
  never runs and a deliberately older `~/.local/bin/subshell` survives the app
  update. Untick the app instead and the node row becomes an act of its own,
  with the number in hand.

  It was not a choice until review on 2026-09-18, and the reason recorded for
  that is worth keeping as a warning: "the marker carries no selection" was
  true of the command as written and was filed as a structural fact. Subshell
  Server had already disproved it — it makes the marker's PRESENCE the
  selection — so what the sentence actually described was one missing boolean.
- **Every sentence promising the node half reads off `pressInstallsNodeCli`**,
  including the air-gapped refusal's "can still be installed". A promise that
  outlives the half it describes is the defect, not the act.

**There is no Force checkbox here, deliberately** (§ 13.3). Force overrides the
pane-safety refusal on a service RESTART; phase 2 in this app restarts nothing,
it OFFERS the restart, and that offer carries its own override behind the CLI's
verbatim refusal. A control governing nothing, rendered for symmetry with
Subshell Server's screen, would be a promise of the same kind. A test pins its
absence.

The same amendment added one refusal that is not cosmetic: a marker on a
machine running a NEWER node is dropped here as well as in Rust, because
§ 13.2 forbids installing an older bundled CLI over a newer installed one under
any consent — and an auto-firing marker is a consent given before the machine
was in that state.

Everything with a contract rather than a rendering is `lib/update-act.ts`:
which rows the screen states, which of them carry a checkbox and which carry a
reason, which phase it is in, which halves are refused and what the press says
it will do. It is mirrored, not shared, with the server app's — one is React
and one is vanilla DOM, exactly as the tmux screens are, and a diff between
them is the drift signal.

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
  through a `LineSink`, `emit_to` the NODE window — not a broadcast, because
  this app's other window is a control plane's own page and a package
  manager's output is not its business. (This bullet said the sink was a no-op
  "because its tmux screen listens for nothing"; that stopped being true when
  the screen grew its progress pane, and the emit's own comment in
  `control.rs` says so.)

  **A failed install is a state the screen renders** (2026-09-18, spec
  `2026-09-17-zero-touch-desktop-setup-design.md` § 11): `tmuxInstallFailure`
  in `lib/copy.ts` — mirrored from the server app beside `manualTmuxRoutes`,
  so a diff between the copies is the drift signal — forks on the result AND
  on whether tmux turned up, because an install that exits ZERO and leaves
  none was indistinguishable from a button nobody had pressed. It matters more
  here than there: the runner's generic failure line is "That did not work.
  See the output below", and this screen renders no `DetailsDisclosure` for it
  to point at, so a failed install said nothing at all. The card carries the
  app's own headline, the manager's last word and both streams behind Show
  output; the button relabels to **Try again**, and `NodeCommands.installTmux`
  re-probes before it spawns anything — the poll is paused while an action is
  in flight, so someone who fixed the machine in a terminal is pressing that
  button to say "look again". A tmux found there returns without spawning, and
  the screen leaves by itself as it always did.
- **`node_set_plane`** remembers a control plane WITHOUT opening its window.
  It exists because `node_open_plane` does both, and the first run's connect
  step must do only the first — a dashboard that appears mid-setup is the
  defect that whole flow removed. The dashboard opens from the status screen's
  own button afterwards.

`node_service` also gained `autostart` beside `force`. It has two jobs and no
others: on `install`, `false` spells `--no-autostart` — the flag that installs
and runs the service but does not arm login start; on the `autostart` VERB
(rails addendum, 2026-09-22 — the day-2 login toggle the server's supervision
screen always had), the boolean IS the request and spells the CLI's two-word
`service autostart on|off`. The Rust side passes the flag on `install` and the
word on `autostart` and refuses both anywhere else, exactly as it refuses
`--force` outside `restart`: the CLI's flag allowlists are per-subcommand, so
the wrong pairing is a usage error rather than a no-op. The probe surfaces the
service's answer `autostart` the way it surfaces the whole `service status
--json` body — verbatim, an untyped passthrough — so no Rust field could
disagree with the CLI's, and an agent too old to answer it reads through
`enabled`, the same fact every agent has always reported.

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

**The rail is for the standing screens, and only for a settled machine**
(wave 3 and its follow-ups; the same rulings the server wave carried —
operator, 2026-09-22). `railFor(screen, settled)` in `lib/client-flow.ts` is
the rule as data: the six sections — **Control Plane**, **Status**,
**Service**, **Update**, **About**, **Reset** (destructive, styled in the
destructive token) — appear only when the machine is settled (`configured()`
and no `FteStep` in progress) and the screen is one of the standing kinds,
and they answer `null` for every step of the FTE walk, for the focused act
(re-enroll, the same kind of moment) and for the not-read state — and for
any standing screen while the machine is NOT settled, because the exclusion
is about the machine's journey, not about who asked: the tray can raise
About mid-walk, and that render keeps its Back. A select is the navigation:
every select sets its override now (see the landing ruling below). Reset's
CONFIRMATION rides the rail (operator ruling 2026-09-22, final word on the
reset layout, superseding the frame-replacing premise for the confirmation:
the sidebar was being lost today and that is not wanted) — the room is the
RUNNING chain: from the confirm press to the chain's end, reset-screen.tsx
hides the rail off the runner's busy and renders no exit, and no navigation
sits beside a chain that is deleting this machine's node. The press itself
STAYS through the chain, disabled and labelled "Resetting…" — the bar
emptying the moment the one irreversible button is pressed reads as a hung
window, not a running chain. That is the server room's busy affordance; the
server can also draw its step meter, and this app has no step events to draw
one from, so the label is the whole of it here. There is NO CANCEL
where the rail is present (operator ruling 2026-09-22, screenshot 59) — the
rail is the way out of the confirmation, and the room keeps no Cancel
regardless; the not-registered refusal reads "This machine is not registered
with a control plane." and the subtitle is "Removes the machine's Subshell
node configuration and data." (both the operator's exact words, same
screenshot); and where the rail
is up, the standing
screens' own leave buttons (About's and Update's Back) render only where the
rail does not. The tray's `desktop-screen` events select their section by
the same override state — no new command.

**The status screen keeps machine state, not the node's machinery** (the
follow-up rulings, 2026-09-22, live screenshots). What moved out of it and
where: the node's install offer (the bordered card titled **Register as a
node** — addendum 3, the operator's exact words; the explainer sentence pair
is DELETED, a later ruling the same day — the button speaks for itself, and
it reads **Install the Subshell Node CLI**; the disabled-no-bundled case
keeps the title and shows only its sentence), its
refusal for a CLI that cannot state its own status, the contextual service
verbs, the pane-safety rewrite door and the unrecognised-state card — all to
the **Service** section, whose subtitle carries the "what is a node" half the
explainer dropped (the node's reveals joined them on 2026-09-22, left with
the bar, and came back onto Status's OWN fact rows on the same day's second
round — misplaced, not surplus); the
configured plane address, the way to change it, "Open in browser instead",
and the node's own view of the same server (its repoint machinery, the
loopback notice and the coherence card) — all to the **Control Plane**
section, which shows the address labeled rather than narrating "This app
opens <url>". **Re-enroll…** moved there too, later the same day (operator
ruling 2026-09-22): overwriting `config.json` and minting a second node row
is an act on this machine's relationship to the plane, not on the machine
itself, and the enroll screen's confirm gate is unchanged. **Register this
machine** moved to the Service section beside the install offer (later the
same day, screenshot 60, the node's machinery home) — same handler, same
walk entry, its override-clearing wiring re-traced to the new screen, the
card titled **Enroll this machine as a node** (the operator's exact words,
the one card-title style) with its long blurb deleted — so the status
screen offers NO act at all. The node-behind
doors the status screen carried ("Update the
node to X…", "Check for updates…") are GONE: the Update section is the door,
and the update screen's own table is where the node row's numbers live. The
the facts render INLINE (no disclosure) on the STATUS screen ALONE
(operator ruling 2026-09-22, screenshot 60, superseding the screenshot-52
scoping: one list, one panel, the `bundled` and `tmux` rows back in). A
screen that needs a fact to explain a state says it in its own card's
sentence; the CLI's last words render as the output block on the screen
that owns the action, and the config fact's value is PLAIN LANGUAGE —
"Not enrolled. Go to Service to enroll." for the enroll-pointing reason,
"The node's configuration could not be read." for any other — the raw CLI
words render only as an action's failure output. Unregister is not a link on the status
screen — the rail's Reset section is its ONLY entry (one act, one door, one
label). There is no Refresh button
anywhere: the probe query re-reads the machine on its own five-second interval
(operator ruling, 2026-09-22) — the poll is the refresh.

**The output block travels with the screen that owns the action** (operator
ruling 2026-09-22, extending the same day's opens-record-nothing rule). An
OPEN records no receipt — the window or browser opening is the feedback —
and an instantaneous save records none either; the runner output's remaining
job is LONG actions' CLI words and FAILURES. What is recorded renders only
on the screen the action was pressed on: `App` tags each outcome with its
screen at press (`useActionRunner`'s `onRun`) and gates the render, so the
reset screen never shows another action's line. The Update screen's own
watch-verdict reads the raw runner output, which is why the rule gates the
render rather than the record. **Every screen that renders the block is
gated** — the fix wave (2026-09-22) found Service and Control Plane still
handing it the raw `runner.output`, a half-gated state where Service's Start
answer followed the person onto the plane cards while the explaining failure
line stayed honest. And a SUCCESSFUL enroll records no visible receipt under
the same ruling: the enroll screen unmounts on success, its words render
nowhere, and the status facts ARE the proof — the opens-record-nothing
precedent, not an oversight; no handoff mechanism exists or is wanted.

**The doors rearranged the same day, twice** (operator rulings 2026-09-22,
screenshots 52/53 and a superseding addendum). The FINAL state: the status
screen carries NO door at all — anything that opens the control plane lives
on the Control Plane section alone, under a **Dashboard** card with both
doors, **Open in browser** (`node_open_plane_url`, the system browser) and
**Open in app** (`node_open_plane`, the in-app window at the re-read settled
address). Control Plane is also the LANDING and reads first in the rail:
`clientScreen`'s configured case answers `plane`, the rail order is Control
Plane | Status | Service | Update | About | Reset, and because "clear the
override" no longer meant "show Status", EVERY rail select is an override
now, Status included. The plane address row is the server Addresses card's
form shape (screenshot 53: the one-line value with its buttons beside it
wrapped the URL character-broken) — since addendum 4 a bordered CARD
labeled **Control plane URL** (the operator's exact words) holding the value
and the acts (Change server…, Re-enroll…), with the Dashboard card below
it. The `no-node` badge
reads **Not registered as a node** (house sentence case, over the operator's
typed capital-N), and the status screen's "This machine is not a node yet…"
sentence is DELETED — the badge already says what the machine is not. The
plane-coherence notice leads with the conflict now (review, 2026-09-22):
"This machine's node reports to <node>, not <plane>.".

**Service joins the server's layout, and the badge joins the header** (the
same day's follow-up, rails addendum: "consistency in offering and UI").
The Service section now offers what Subshell Server's Service offers, adapted
to a node: the arrangement stated as one card — **In the background**, naming
no manager — the run-at-login switch nested under it
("Start automatically on startup"). The named thing is the **Subshell
Node Service** (the server app: the **Subshell Server Service**), and the
card STATES THE CURRENT CONDITION ("Currently the Subshell Node Service
runs in the background, but does not automatically start on startup.")
while the switch help says what flipping it changes. The first-run
question keeps its shorter "Start at login": the walk's own wording stands).
For an installed service come the lifecycle verbs (Start when it is down,
Stop and Restart when it is up with the pane-safety force flow unchanged,
Uninstall confirmed in its own words), and the install-service door for a machine whose
node CLI is installed but whose service is not — driven by the definition,
not only the step word, so no enrolled "nothing installed" answer can miss it.
Node-specific differences stay: there is no app-managed-child supervision
choice, because this app does not supervise its node that way. The two
bottom-bar **reveals are gone from the bar** ("feels out of place... remove
them") — and round two (same day) put the affordance back where the server's
has always sat: inline on the Status fact rows whose value IS a path, with
`node_open_path` restored unchanged, permission included, as one atomic ACL
commit. On both standing screens the
STATE BADGE reads in the Frame header between the title and the subtitle:
the client's `Frame` grew an optional `badge` slot; the shared package Frame
is untouched, because the server's Status section has no badge to move. The
switch is only honest because the node CLI gained the verb behind it — see
`apps/node/agent/AGENTS.md`, "service autostart" — and it is gated on that
verb: an agent older than `0.15.0` can READ the state (it has answered
`enabled` forever) but cannot WRITE it, so the switch shows the answer
greyed with "Currently the installed version cannot change this. Updating
to version 0.15.0 lets you." (`lib/autostart-gate.ts`, the server's
`MIN_AUTOSTART_SERVER_VERSION` pattern; the server app keeps its own shorter
sentence for its gate). Where neither `autostart` nor `enabled` answered,
the switch greys showing no guessed value, the help line stays empty, and
the card itself carries the fact: "Whether it starts on startup is not
reported." The switch's help states the CURRENT condition in every state it
can speak — armed, disarmed, too-old — operator ruling 2026-09-22: the card
says what is, the toggle says what flipping it changes.

Three screen ids went with it, and their absence is the design.
**`connected`**, **`service`** and **`install-agent`** were the probe-derived
landings; their content is distributed across the rail now — the service
verbs on **Service**, the split that decides whether
registering may be offered at all on **Status** (below) — and the configured
client lands on **Control Plane** (operator ruling 2026-09-22, second
addendum; it was `status` until that afternoon). A screen nothing can
route to is not a recovery path; it is dead code that reads like one.

An address no longer comes first, either, and that reversal is load-bearing:
`configured()` counts an ENROLLED machine as well as a stored `planeUrl`,
because the walk ends at Register and Register on a node mints a second node
row and discards its node key. Screens a person ASKS for rather than states
a machine implies (re-enrol, reset, plus about and update) arrive as the
`override` — and since the landing moved to Control Plane, EVERY rail select
is an override too, Status included, or a Status select would clear the
override and land on Control Plane with Status highlighted nowhere. `update`
is the one the MACHINE may also raise: an app update left a marker, and the
process that boots into it opens the screen once per launch to finish the act
(see "Updating is one act", below).

**`no-node` reads two ways, and status must keep them apart.** The Rust side
folds "nothing on the ladder answered" and "a binary answered `version` but not
`status --json`" into one step on purpose (control.rs says why). Where nothing
answered, installing is safe unconfirmed and is offered ON ITS OWN — not folded
into Register, because a machine with no node cannot say whether it is already
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
- **Stop and Uninstall left the app, then came back.** Restarting a node is a
  control-plane action too (spec 2026-09-12 § 6.3, `POST /api/nodes/:id/restart`),
  and Reset tears everything down — but the rails addendum (2026-09-22,
  server parity) put the full lifecycle back on the Service section: an
  installed service that is running gets Stop, Restart and Uninstall there,
  one that is down gets Start. The pane-safety rule is unchanged: Restart is
  still the two-phase refusal read before `--force`, Uninstall still names
  its cost before it runs, and the one REMEDY the refusal names by label —
  rewriting a definition that would SIGKILL live panes — is still a card of
  its own because the confirmation points at that button.
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

- **The reveal lives on the row, not the bar (round two, 2026-09-22).**
  The first parity pass retired `node_open_path`, its closed
  `config-dir | data-dir | node-log` enum, its ACL entry and its ipc wrapper
  with the Service bottom bar, and the three-way pin correctly read a
  command no page invoked as surface to delete. The audit addendum the same
  day found what was wrong was the PLACEMENT: the server's Status rows carry
  an inline Reveal on each path fact, naming an intent for Rust to
  re-resolve from its own fresh probe. Round two restored the whole surface
  unchanged and moved the buttons onto Status's `config file` and `logs`
  rows — restore and grant are ONE commit, command + permission +
  capability + pin, the same atomicity rule from the other direction. A
  hint row reveals nothing: on Linux there is no file to reveal, and the
  `journalctl` sentence IS the remedy, rendered on the facts row and on the
  Service screen's offline card.
- **`node-log` resolves the node's OWN capped file first**, on every
  platform (2026-09-18) — `~/.config/subshell/logs/agent.log`, the same
  JSON-lines file the plane's node log view serves, so the path the facts
  list names and the log a browser reads cannot be two different documents. That is
  the order `apps/server/desktop`'s `desktop_logs` reads the server's log in,
  for the same reason. The service manager's redirect is the FALLBACK and a
  genuinely different artifact: `~/Library/Logs/subshell.log` holds the raw
  stdout of a node that died before opening its own file (Linux has no such
  file — the unit redirects nothing, so the fallback is the journal sentence).
  A rung counts only when it has CONTENT, not merely when it exists, because
  the capped writer truncates to zero and starts over — the same rule
  `server_log_tail` follows. `node_log_paths_from` takes its two roots and a
  content predicate so the ORDER is tested without a machine in a particular
  state.
- **The Status section's Node log pane (round two, 2026-09-22).** A group
  heading over a scroll-stick `pre`, fed by the new `node_logs` command —
  ARGUMENT-LESS, like the server's `desktop_logs`: Rust locates the file
  through the same `node_paths` the probe reports (so a page can name no
  file), renders the capped JSON-lines to `HH:MM:SS level message` with
  unparseable lines kept VERBATIM, caps at the server's 200, and answers
  `{text, source, note}` where every failure is a caption the pane renders,
  never a rejection. The HOST feeds it only while Status is the shown
  section (the server host's `statusUp` rule), once on arrival and then per
  probe tick; the tick it rides is the probe query's `success` cache event,
  because structural sharing hands an unchanged machine the same data
  reference and a fast poll even the same-millisecond timestamp
  (both measured). What is deliberately NOT ported from the server's
  StatusDetails: its "Last action" pane — this app's output-ownership
  ruling already decides where an action's words render (the screen the
  press happened on), and a second always-on copy on Status would
  contradict it. That, the missing app-managed-child choice, and the switch
  gate naming 0.15.0 where the server's names its own floor, are the three
  honest places the two sections read differently, each on purpose.
- **The plane's second door.** `node_open_plane_url` opens the settled control
  plane in the SYSTEM browser — for what the in-app window is wrong for (a
  different profile, a share, passkeys). The page passes NO URL: the command
  re-reads the same ladder `node_open_plane` points a window at. On the Connect
  screen it therefore has to PERSIST the typed address first and open the
  browser once that lands, because an address never saved cannot be re-read —
  and the action runner drops a concurrent submission, so the two cannot be
  fired together.
- **tmux is a gate, not a caption.** Enroll and the service verbs that START
  things (Install, Start, Restart) are disabled while the probe cannot find
  tmux — `enroll` refuses CLI-side and a tmux-less node comes up online with
  no harnesses, so a live button only manufactures the failure. The verbs
  that cannot manufacture it stay live: Stop and Uninstall take things down,
  the run-at-login switch writes only the NEXT login, the Status rows'
  Reveals open paths whatever tmux is doing, and a disabled one of
  those strands the box. The hint names the install command
  (`TMUX_INSTALL_CMD`), and the gate reads the CURRENT probe, so installing
  tmux re-arms it.
- **The manager row says what the manager said.** `probe-facts` appends the
  service `detail` verbatim (`launchd: spawn scheduled` is the crash-throttle
  wait) and paints `state: unknown` bad — a manager that would not answer is
  not the same fact as a stopped node.

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
node's own `subshell status --json` `paths` block; `node_reset` deletes exactly
that, gated on the typed hostname. The plan is stashed at press time rather than
re-read inside the chain because the chain UNINSTALLS the very node whose
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
  failed" turns every stopped node into an error dialog.
- **`subshell status --probe` is destructive.** The control plane's node registry
  is newest-wins, so a probe supersede-kicks a live node (close 4409) —
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
  `NodeCommand::Enroll` carries `name: String`, so a nameless enroll is not
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
  the service definition bakes only PATH: a node enrolled under a relocated
  config home is started by a service that looks in `~/.config/subshell`, finds
  nothing, and crash-loops silently.
- **Restarting the node can kill every pane on this machine.** A node runs its
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
