# Desktop client AGENTS.md

`apps/client/desktop` (`@internal/desktop-client`) is **Subshell Client**, a
**Tauri v2** shell that is a user's interface to a control plane, and the place
their machine is registered as a node, so neither job needs a CLI binary.

Read `docs/superpowers/specs/2026-09-07-app-vocabulary-design.md` first if the
words are new. Three of them each name exactly one thing: a **server** is a
control plane, a **node** is a machine that runs agents, a **client** is a human
interface to a control plane. This app is a client that can also make its
machine a node, which is why "node" appears all over it without contradiction:
the machine it registers IS a node, the `node_*` commands act on it, the
server's Nodes page lists it, and the sidecar stem names the node it wraps.

It is the counterpart of `apps/server/desktop`, and the two are shaped alike:
each has a window holding a remote page and a window holding its own bundled
one. Read that app's `AGENTS.md` too; most of the machinery is documented there
once.

**Styling follows `docs/design-system.md`** (six type roles, two weights,
shadcn colour names), and `bun run lint:design` fails on a literal size,
weight or colour outside the token file. Pick a role, never a number.

## Two windows, and why that is the whole design

| window | page | granted |
|---|---|---|
| `main` | the control plane's own UI, at the plane's origin | **one command**: `desktop_open_in_browser` |
| `node` | `ui/dist/index.html`, the bundled assistant | every `node_*` command |

`main` loads the plane's own page rather than a bundled copy because
`apps/server/web` is hard same-origin (relative `apiFetch` with
`credentials: "include"`, an auth client with no `baseURL`, a WebSocket URL
built from `window.location.host`), so a `tauri://` page could not carry the
`SameSite=Lax` session cookie to any of them.

**`capabilities/main.json` grants that window ONE command, and the narrowness
is in the ARGUMENT rather than in the scope.** `apps/server/desktop` can pin
its remote window to loopback because it manages the server serving it; a
control plane can live on any host, so there is no equivalent pin here. The
capability's `remote.urls` is therefore a WILDCARD (`http://*:*`,
`https://*:*`; `http://*` alone does not match a non-default port in the
`urlpattern` crate Tauri 2.11.5 uses, which would silently exclude the default
`:3080` plane), and the command is what has to be safe.

Until 2026-09-14 that file did not exist, and the ABSENCE was the boundary.
That was right while a plane's page had nothing useful to ask for. "Open in
browser" is useful: a webview has no address bar and no second tab, and the
page a person wants in their real browser (with their profiles, their password
manager, their extensions) is the one they are looking at.

- **`desktop_open_in_browser` takes a PATH.** It must start with `/`, must not
  start with `//` (protocol-relative names a HOST), and may contain no `://`,
  no backslash (`\` is `/` to the WHATWG URL parser, so `/\evil.test` is the
  same attack in another spelling), no whitespace and no control characters.
  The rule and its tests are `crates/desktop-core`'s `browser` module, shared
  with the other app so the two cannot disagree about what a path is. The
  ORIGIN comes from `PlanePin`: the origin this window was OPENED with, which
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
  "Open in browser" surfaces, the sidebar row and a subshell's actions menu.
  So there is still no `shell_ready` handshake and no `bridge.rs` CustomEvent
  bus here: this window's whole Tauri surface is one command.
  `withGlobalTauri` is `true` for the same reason (see below).
- **What IS kept:** an `on_navigation` SCHEME refusal (the origin pin went on
  2026-09-18, see above; the window follows http(s) so a proxied sign-in
  works, and non-http(s) is still refused so it cannot be steered into
  anything the OS would act on), `disable_drag_drop_handler`
  (Tauri's native file-drop handler otherwise swallows the HTML5 drags behind
  drag-a-subshell-into-a-workspace and the terminal's uploads), and a 360x240
  minimum size (a third of the SPA's 1024px tiling breakpoint), so the window
  can be parked in a corner and renders the SPA's narrow chrome when it is.

**The node window is a FIXED 1024x720 assistant frame** (spec 2026-09-12 § 6.4),
non-resizable and centred, and the window-state plugin is DENYLISTED for it.
Both halves matter: the screens are drawn to that arithmetic, and the plugin
restores geometry after the builder sets it, so a saved size from the window's
resizable 760x720 era wins silently. `apps/server/desktop` found exactly this
by running its app (43f6682) and the fix is the same: denylist the label
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
the control plane's dashboard by itself now; a configured client lands on its
own client-status screen and the dashboard opens from the button there.

**It must always have a route home, and the tray is not one.** A tray icon is
silently invisible wherever no StatusNotifier host answers, so macOS gets
**Window → Open Client App** and everywhere else `focus_any` RE-CREATES the
node window when the tray probe says no. Full mechanics:
`apps/client/desktop/docs/tray.md` ("Route home").

The `csp` in `tauri.conf.json` governs the **bundled** page only. The plane's
window carries whatever CSP the plane sends, which is the same split
`apps/server/desktop` has, and the reason nothing privileged lives there.

## The page (`ui/`): React, on the same stack as `apps/server/web`

`ui/` is a small **React + Vite + Tailwind v4 + TanStack Query** app, built to
`ui/dist` (the `frontendDist`). It mirrors `apps/server/web`'s stack minus what
the bundled page has no use for: no router (one page and a step machine, so
there are no URLs), no xterm, no dockview, no better-auth, no
`@internal/backend-client`. Every shared version is pinned to the same string
`apps/server/web/package.json` uses: `bun run syncpack:lint` fails otherwise.

Three things about it are load-bearing:

- **The typed IPC contract is `ui/src/lib/ipc.ts`**, one narrow function per
  `node_*` command, transcribed from `src-tauri/src/control.rs`. Nothing
  generates it, so `ui/src/__tests__/ipc-acl.test.ts` reads
  `permissions/desktop.toml` and `capabilities/node.json` and asserts the
  granted command set is exactly the invoked one. That three-way mismatch is a
  runtime permission rejection, not a compile error. The same file asserts what
  the `main` window holds: one permission, one scope, one Rust signature.
- **`withGlobalTauri` is `true`, and it is the OTHER window that needs it.**
  This page imports `invoke` from `@tauri-apps/api/core` and has no use for a
  global; it was `false` from the day that import landed. What changed on
  2026-09-14 is that the plane's window has something to invoke, and
  `apps/server/web`'s bridge (`src/lib/desktop.ts`) reads `window.__TAURI__`
  and imports nothing by design: it must not pull `@tauri-apps/api` into a
  bundle served to browsers, and the repo forbids the dynamic import that would
  avoid that. The global GRANTS nothing; `capabilities/main.json` does. Turning
  it back off would not close a hole, it would make that one command silently
  unreachable: the bridge never throws, which is exactly the failure
  `apps/server/desktop` measured on 2026-09-10 when its config was copied from
  this one. `ui/src/__tests__/tauri-config.test.ts` pins the PAIR: while
  `windows.rs` ships a marker, the global must exist.
- **Design tokens and the `components/ui/` primitives are COPIED** from
  `apps/server/web`, verbatim except the `cn` import path. Copied rather than
  shared so extracting them into a package later is a straight move, and so a
  diff between the two copies is the drift signal.

## Native prerequisites

`bun install` covers none of them: Rust (MSRV 1.82, with `rustfmt` and
`clippy`, which `bun run rust:check` runs) and, on Linux, Tauri's system
packages; macOS needs only the Xcode command-line tools. The minimum glibc is
**2.39 by choice** (the builder image is ubuntu24.04), which excludes Ubuntu
22.04 and Debian 12. A missing library surfaces as a `cargo` link error, not
a clear message. **Setting up a bare machine: read
`apps/client/desktop/docs/prerequisites.md` first.** It carries the install
commands and the `pkg-config` check list (including why `pkg-config` alone
false-MISSINGs `libxdo-dev`).

## Commands

```bash
# From the REPO ROOT, the command that builds the CLI and stages it first,
# and refreshes ~/.local/bin/subshell, which is what this app
# actually runs (the sidecar is on no rung of the ladder; root AGENTS.md):
#   bun run dev:desktop-client
bun run dev:app             # tauri dev (needs a staged sidecar; see below);
                            # runs `dev:ui` for you via beforeDevCommand
bun run dev:ui              # just the Vite dev server, on :5177
bun run build               # vite build -> ui/dist   (pure JS; safe in CI)
bun run compile             # tauri build --debug
bun run test                # bun test src  +  bun test in ui/  (see below)
bun run verify-types        # both tsconfigs: src/ (bun) and ui/ (react)
cd src-tauri && cargo test  # the Rust half: the ladder, the parsers, the policy
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

There is deliberately **no `dev` script**: root `bun run start` is
`turbo watch dev`, and a `dev` task here would spawn a Vite server for everyone
working on the backend. The Vite port is **5177**, not a neighbour of
`apps/server/web`'s 5174: Vite walks upward from a taken port, and `devUrl` is a
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

A zero-byte stub is correct for the Rust tests: none of them executes the
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
node, which is exactly the file this app has to be able to tell apart from
its own.

## Identity: four strings that must differ from `apps/server/desktop`

| | desktop-server | desktop-client |
| --- | --- | --- |
| Cargo crate | `subshell-desktop` | `subshell-desktop-client` |
| bundle identifier | `dev.subshell.server` | `dev.subshell.client` |
| `productName` | `Subshell Server` | `Subshell Client` |
| sidecar stem | `subshell-server-bundled` | `subshell-node-bundled` |
| published `.dmg` | `Subshell-Server-Desktop-<v>-<darwin-triple>.dmg` | `Subshell-Client-Desktop-<v>-<darwin-triple>.dmg` (one per Mac triple: `darwin-arm64`, `darwin-x64`) |
| published `.deb` | `subshell-server-desktop_<v>_amd64.deb` | `subshell-client-desktop_<v>_amd64.deb` |

Both packages can be installed on one machine and both put a binary in
`/usr/bin` on Debian, so a shared string is a file conflict. The identifier is
additionally the macOS settings directory
(`crates/desktop-core`'s `SettingsPaths`), the notification permission grant,
the single-instance lock and the window-state store, and macOS tracks an app BY
it (an identity rather than a label), which is why
`src/scripts/__tests__/release.test.ts` and `src-tauri/src/lib.rs` both pin it.

**The Linux settings directory is `subshell-desktop-client`, not `subshell`.**
`~/.config/subshell` is the AGENT's own config home
(`apps/node/agent/src/config.ts`: `config.json` and the 0600 node key), and this
app writing `settings.json` in beside it would put two programs' state in one
directory. `apps/server/desktop` is prefixed for the same reason, against the
server CLI's `~/.config/subshell-server`.

Cargo crate names and sidecar stems are deliberately not renamed in step with
the products: the crate name is the `/usr/bin` binary in the `.deb`, and the
sidecar stem names the binary this app WRAPS rather than the app.

`productName` may contain a space: Tauri derives the `.app` directory name, the
DMG volume and the `.deb` file name from it, and the Debian one goes through a
package-name sanitizer nobody can predict without running the Linux bundler,
so the release script does not predict names. It globs `bundle/<dir>` for the
ONE artifact that appeared and publishes it under the name
`desktopArtifactFileName` chooses (space-free: these are download URLs and
shell arguments). The `.app` inside that mounted image is `Subshell Client.app`,
space included, which is why the smoke quotes its paths. Tauri only SIGNS the
image (it notarizes/staples the `.app` and stops), so the pipeline runs
`notarizeAndStapleDmg` before digesting, and the smoke's `stapler validate` on
the IMAGE is what proves it.

The window title, tray tooltip and menu titles read "Subshell Client"; those
are free-form and are not `productName`.

## Where things live

```
src-tauri/src/
├── node_bin.rs   the resolution ladder for `subshell`, and the bundled-vs-installed policy
├── control.rs     the `node_*` commands, and Probe
├── reset.rs       the delete plan, the stashed consent, and the chain that honours it
├── windows.rs     the two windows: the plane's page and the bundled node assistant
├── tray.rs        tray icon + menu (an explicit id; a Menu attached, or Linux may not register it;
│                  the close-to-tray CheckMenuItem lives here)
├── menu.rs        the macOS menu bar, module-gated, because Linux has none
└── lib.rs         plugins, environment scrubbing, lifecycle

ui/                the bundled page (React + Vite + Tailwind), built to ui/dist
├── src/lib/       ipc.ts (the typed command contract), node-assistant-state.ts (which
│                  screen this machine sees), probe-facts.ts, plane-coherence.ts, copy.ts
├── src/hooks/     the two queries, the serializing action runner, the commands
├── src/components/ui/   primitives copied from apps/server/web
├── src/components/assistant/   the frame and the screens (NodeScreenId)
└── src/components/      what the screens compose (enroll fields, the confirmation, the footer)
vite.config.ts     the web build; `ui/` is its root
src/scripts/       the release script (TS): `bun run compile:release`
```

Shared with `apps/server/desktop` via `crates/desktop-core`: process spawning
with a login PATH and a deadline, the login-shell PATH probe, semver
comparison, the settings file, the atomic sidecar install, and the tray
capability probe that gates close-to-tray. Do not re-implement any of those
here. (`src-tauri/src/tray.rs` is the ICON: builder, menu, ids;
`desktop-core`'s `tray.rs` is the different question of whether an icon is
drawn on this desktop at all.)

## Installing the bundled node, and updating the app: ONE act, in two phases

Spec `docs/superpowers/specs/2026-09-18-one-update-act-design.md`. Updating
this app and updating the node CLI are ONE act whose phases are separated by
the relaunch: `node_install_app_update` writes the `pending_bundled_install`
marker before `app.restart()`, the new build resumes through `desktop-core`'s
`resume_decision` (whether work EXISTS stays the machine's answer), and
`node_install_cli` counts and clears attempts so every door is bounded
(`MAX_RESUME_ATTEMPTS` = 2) by one piece of code. The install is a
transaction: a managed CLI gets `<installed> update --from <sidecar> --yes
--no-restart --json` (flags spelled once in `desktop-core`'s
`cli_update::update_args`); a first install copies, and a node too old for
`update` falls back to that copy, detected by the CLI's own
`unknown command 'update'` marker, never an exit code, and the screen then
SAYS no rollback point was recorded. The screen is a selection table,
all-or-nothing, stating a reason where an act is impossible and deliberately
carrying no Force checkbox here (phase 2 restarts nothing; it OFFERS the
restart, where the pane-safety override lives). The publisher keypair is
shared with `apps/server/desktop`: losing it means no installed app ever
auto-updates again. And with the pubkey configured, `bun run compile` needs `TAURI_SIGNING_PRIVATE_KEY`
set (`tauri dev` is unaffected). **Working on install or update: read
`apps/client/desktop/docs/updates.md` first.**

## The IPC boundary

`permissions/desktop.toml` is the app's ACL manifest and it is load-bearing **by
existence**, not only by contents: Tauri gates an app command when
`plugin_command.is_some() || has_app_acl_manifest || !is_local`. Delete it and
every command becomes ungated for every local window, which now matters
concretely, because there are two windows and only one of them may drive the
CLI.

Command names live in that file and in `capabilities/node.json`. Changing one
without the other produces a command that is refused at runtime with a message
about permissions, not a compile error. `ui/src/__tests__/ipc-acl.test.ts`
reads both files and the invocations in `ui/src/lib/ipc.ts`, and fails on any
three-way mismatch: add the command in all three or the test names the one
you missed.

The commands that arrived with the first run (`node_install_tmux` and the
failure state its screen renders, the plane-list pair `node_plane_add` /
`node_plane_remove`, and `node_service`'s `autostart` flag) are deep-dived
in `apps/client/desktop/docs/node-assistant.md`.

## The node page is an assistant

One screen at a time, each asking exactly one question, in the frame Subshell
Server's assistant uses (spec 2026-09-12 § 6.4). Routing is ONE router,
`lib/client-flow.ts`: `clientScreen({probe, settings, step, override})` asks
what this person came to do before what this machine implies (the in-memory
`FteStep` walk outranks the machine rules; a configured client lands on
**Control Plane**), and `railFor` shows the six standing sections (Control
Plane | Status | Service | Update | About | Reset) only for a settled
machine, every rail select being an override, as are the screens a person
ASKS for (about, update, enroll). Confirmations answer in a dialog at the
single `shell.confirm` slot; the rail's Reset is a door, not a section. The
status screen keeps machine state and offers NO act; an action's output
renders only on the screen that owns it; there is no Refresh button (the
probe's poll is the refresh); version gates (`lib/autostart-gate.ts`,
`lib/unenroll-gate.ts`) grey a control with a stated reason rather than hide
it. **Working on the screens, rails, gates or copy: read
`apps/client/desktop/docs/node-assistant.md` first.**

## Text size is Rust's, not the page's

⌘+ / ⌘− / ⌘0 and the tray's **Text Size** submenu walk `desktop-core`'s
fixed zoom ladder, stored as `zoom` in this app's `settings.json` and
applied with `WebviewWindow::set_zoom`, never Tauri's own
`zoom_hotkeys_enabled`, whose page-injected path would need a plugin command
the plane window is not granted. A Tauri menu event is GLOBAL, so both
menus share one id set routed in exactly one place (`lib.rs`'s
`on_menu_event`). The level is clamped on READ, and the SPA's window floor
and the assistant frame scale with it. **Working on zoom: read
`apps/client/desktop/docs/zoom.md` first.**

## About is a screen you ask for, not a footer

`components/assistant/about-screen.tsx`, reached from the tray as a
`NodeUserScreen` override (macOS instead gets the system's own About panel);
no probe ever implies it. The raise fires on "a page is LISTENING"
(`PendingScreen.listening`, pulled by a booting page via
`node_pending_screen`), never on window existence. The content comes from
one `node_about` call, so the facts live only in
`crates/desktop-core/src/legal.rs`. **Working on About: read
`apps/client/desktop/docs/about-screen.md` first.**

## The tray

`close_to_tray` is a `CheckMenuItem` in the tray menu, not a settings
command; muda flips the item's own state before the event fires, and the
CLAMP on a tray-less desktop is what makes the ON default safe (the probe
itself is in "Things that will bite" below). The Control Plane submenu
mirrors the plane list: **Open Last** plus one submenu per address, the
node's own connected address first, canonical URLs carried as menu-id data
and RE-VALIDATED before acting. The menu is rebuilt from live state on
every mutation, never from inside its own event handler. `Open Client App`
is the one window item and the route home when no tray icon is drawn (see
"Two windows" above). **Working on tray items, the close-to-tray check, or
the route-home path: read `apps/client/desktop/docs/tray.md` first.**

## Reset: returning this machine to un-enrolled

`src-tauri/src/reset.rs`, shaped like `apps/server/desktop`'s: **the page
supplies a typed hostname, never a path.** `node_arm_reset` stashes a delete
plan parsed from the node's own `status --json` `paths` block AT PRESS TIME
(the chain uninstalls the very binary a re-read would ask), all-or-nothing,
with `config.json` deleted LAST so a half-run stays resumable
(`deletion_order` is a tested pure function), the shared guards in
`subshell_desktop_core::reset_guards`, and `Err` only for refusals before
the first mutation. `planeUrl` is KEPT. **Working on reset: read
`apps/client/desktop/docs/reset.md` first.**

## Things that will bite

- **The CSP blocks inline style ATTRIBUTES, not just `<style>` elements.**
  `style-src 'self'` with no `'unsafe-inline'` means a React `style={{…}}` prop
  is a silently unstyled element: no error, no warning, and it looks correct
  under `tauri dev`, where `app.security.devCsp` relaxes exactly that rule so
  Vite's HMR works. Tailwind classes only; `ui/src/__tests__/no-inline-styles.test.ts`
  fails on a `style` prop or `dangerouslySetInnerHTML` anywhere under `ui/src`.
  For the same reason, **do not reach for a portalled or anchored Base UI
  component** (popover, tooltip, select): they position themselves with inline
  styles. And Vite's module-preload polyfill is an inline `<script>`, which is
  why `modulePreload.polyfill` is off in `vite.config.ts`.
- **Base UI's `Switch` needs a stylesheet workaround for that.** `Switch.Root`
  renders a hidden native checkbox (as a SIBLING of the root, not a child), and
  hides it with an inline style, so under the shipped CSP it becomes a visible
  stray checkbox. `ui/src/styles.css` restates the hiding from a stylesheet;
  `ui/src/__tests__/switch-csp.test.tsx` fails if Base UI stops emitting that
  input, at which point delete both.
- **`subshell status` exits 1 whenever the node is offline.** The exit code is a
  hint; the JSON body on stdout is the answer. Treating non-zero as "the command
  failed" turns every stopped node into an error dialog.
- **`subshell status --probe` is destructive.** The control plane's node registry
  is newest-wins, so a probe supersede-kicks a live node (close 4409),
  possibly one running on another machine for the same node. Nothing in this app
  may call it: not on a timer, not behind a button.
- **`enroll` has no already-enrolled guard.** It overwrites `config.json`, mints
  a SECOND node row on the server, and discards the old node key whose only home
  was that 0600 file. `node_enroll` therefore takes a `confirm` flag and spawns
  nothing until it is true, and since the plane-list wave that flag guards the
  app's ONLY re-binding door too: Re-enroll… opens this same walk, so
  overwriting a live config can only happen behind the two-phase confirm. The
  cheap alternative the app once offered, `node_configure`
  (`subshell configure --server`: repoints, keeps identity, spends no key), was
  retired from the client with that ruling; it survives as a CLI verb.
- **The app's addresses and the node's address are different things, and the
  list's shape says so.** The app stores a LIST (`settings.planes`, bookmarks
  it can connect to); what the daemon dials is the node's `serverUrl`, read
  off the probe and rendered as the list's PINNED row. That replaced the
  single `planeUrl` with its `plane_url_from` fallback ladder and
  `plane-coherence.ts`, all three deleted by the plane-list wave: with the
  node's address a row of the same list, "the app opens one plane while the
  node dials another" has no rendering left: the rows ARE the notice.
- **The node's address shows in two places, neither as a fact row**: the
  Control Plane section's pinned row (its menu points at Service for the
  detaching acts) and Service's Enrolled to Control Plane card, where the
  enroll-time loopback warning sits with it and with the walk door. The
  Status fact rows never carry a plane address; the subtitle states the
  machine, and a test pins the address's absence from the facts list.
- **A setup key is single-use and lasts 24 hours.** Everything checkable is
  checked before the server consumes it, but a 409 (name already taken) or a 500
  arrives AFTER, and spends it. Those say "mint a new key", never "retry".
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
  representable. What the control plane stores is `normalizeNodeName`'s output
  (imported from `@internal/subshell-protocol` rather than re-implemented here),
  so a pasted name cannot be clean in this app and collapsed only at the server.
- **A GUI process's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.** `service install`
  bakes `Environment=PATH=` from the environment it runs in, so without the
  login PATH the node comes up ONLINE with an empty harness inventory and 409s
  every launch, far from the cause. Every spawn goes through
  `desktop_core::proc`, which injects the login PATH.
- **Never spawn `subshell run`**: it never resolves, and it competes with the
  installed service for the same node; both restart on exit, so they flap.
  **Never spawn `subshell mcp`**: it is per-pane internal plumbing.
- **`SUBSHELL_CONFIG_HOME` is scrubbed from the process at startup**, because
  the service definition bakes only PATH: a node enrolled under a relocated
  config home is started by a service that looks in `~/.config/subshell`, finds
  nothing, and crash-loops silently.
- **Restarting the node can kill every pane on this machine.** A node runs its
  subshells' tmux servers as CHILDREN of its own unit, so a definition without
  `KillMode=process` / `AbandonProcessGroup` takes them all down. The CLI
  refuses such a restart without `--force`; surface the refusal and make the
  override a separate, labelled action.
- **The Linux tray may be silently invisible, so it is PROBED, not assumed.**
  `TrayIconEvent` is never emitted there, and the icon is drawn only where a
  StatusNotifier **host** is registered on the session bus (KDE yes, stock
  GNOME no until the AppIndicator extension). `crates/desktop-core/src/tray.rs`
  asks, by shelling out to
  `busctl --user get-property … IsStatusNotifierHostRegistered`, and every
  non-affirmative outcome (no bus, no watcher, no tool, a timeout) means "no
  tray". Close-to-tray defaults ON since 2026-09-07 (the tray-resident
  controller is the point of these apps) and the CLAMP, not the default, is
  what makes that safe on a tray-less desktop; `node_set_close_to_tray` refuses
  `true` where none answered; `node_settings` clamps the stored value on READ
  too; and the window-close handler **re-probes**, which is the guard that
  actually protects the user: the setting may have been made on a session that
  had a tray. The probe is deliberately not memoized for that reason, and the
  page draws the switch DISABLED with the reason plus a re-check (never hidden)
  when `trayStatus` is `not-detected`, because naming the extension is
  actionable and an absent control is not. It is a false negative on the older
  XEmbed tray, which is why every string says "none was detected".
- **The two apps' icons differ only by BACKGROUND COLOUR** (`brand/generate.ts`:
  plum here, near-black for the server), which is also why the tray icon is
  NOT `icon_as_template(true)` on macOS: a template icon is drawn from the alpha
  channel alone and both would collapse to the same filled square.
