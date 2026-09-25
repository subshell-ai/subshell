# Desktop AGENTS.md

`apps/server/desktop` (`@internal/desktop-server`), **Subshell Server**, a
**Tauri v2** shell that installs, runs and manages a `subshell-server` on this
machine, so a user never has to touch a CLI binary.

**Styling follows `docs/design-system.md`** (six type roles, two weights,
shadcn colour names), and `bun run lint:design` fails on a literal size,
weight or colour outside the token file. Pick a role, never a number.

**Deep dives load on demand.** Topic detail an agent needs only when working
IN that area lives in `apps/server/desktop/docs/`; each moved section leaves
behind a summary and a routing line naming the file to read first.

## Two windows, and why they are two

| Window | Page | Why |
| --- | --- | --- |
| `wizard` | `ui/dist/wizard.html` (Vite output; sources in `ui/src/`), bundled, `tauri://` | **The assistant.** Must render with the server DOWN, and is the only surface allowed to drive the CLI. Owns first run, recovery, update and reset. |
| `main` | the SERVER's own SPA over `http://127.0.0.1:<port>` | `apps/server/web` is hard same-origin. |

**The label is `wizard` and the page is the assistant, and that is deliberate.**
`wizard` is an IDENTIFIER (it keys `WebviewUrl::App("wizard.html")`, the
capability file, every `get_webview_window` lookup and the Vite input), while
the page it carries stopped being only a setup flow. Renaming it would move
four things to rename one, which is the same distinction the root `AGENTS.md`
draws between a directory name and a component id.

**The `console` was deleted on 2026-09-12**: what a running server can manage
moved into the SPA, everything that must work with the server DOWN moved into
the assistant, and what is left here is exactly the second half. And `main`
never loads a bundled copy of the SPA: a `tauri://` page cannot carry the
`SameSite=Lax; httpOnly` session cookie to its root-relative,
`credentials: "include"` fetches, so serving the SPA ourselves would mean an
auth rework, not a build change. (The history, the deleted files and the
four API sites that pin this: apps/server/desktop/docs/assistant.md.)

## Boot looks before it leaps

`setup()` runs one `boot_probe` and THEN chooses the window, from the fresh
probe rather than the stored flag: `boot_window(pref, &Probe)` answers
`WindowChoice::Main` on a `ready` probe and `WindowChoice::Wizard` on anything
else. So a machine whose server is already running opens the **dashboard**
(including one provisioned entirely from the CLI, on its first app launch,
because the boot probe answers `ready` before the branch runs).

**The launch preference** (`settings.json`'s `openOnLaunch`: `dashboard` or
`assistant`) moves only the ready arm: a machine that is NOT ready has no
dashboard to open, so it comes up on the assistant whichever way the
preference is set. And one thing outranks it: `control::boot_resume` finding
an update whose second half never ran, which opens the assistant at `update`.
The commands are `desktop_launch_window` / `desktop_set_launch_window`
(`wizard`-only), and `open_home` deliberately IGNORES the preference. (Full
rule: apps/server/desktop/docs/assistant.md.)

**`onboarded` no longer decides the window.** It decides which FAMILY of
assistant screens a not-ready machine sees: the first-run trio while setup has
never completed, the one recovery screen once it has. `mark_onboarded` is still
the SINGLE writer of the flag (R16) and the only thing that sets it is a probe
whose decision is `ready`; reset is the only thing that moves it back.

Every route home (the tray item, the tray click, the Dock reopen, the
single-instance relaunch, the macOS menu's no-window fallback, and the SPA's
own footer pill) goes through **one function**:

```rust
open_home(app):  probe_now(); if ready → open_main_now() else → open_assistant(None)
```

One function, so no two openers can disagree about which window this machine is
owed. `open_manage_window` and its stored-flag branch are gone with the console.

## The assistant

One frame, one screen: `screensFor(probe, onboarded)` picks the family (pure,
`ui/src/lib/wizard-state.ts`); the standing rail shows only for an onboarded
machine, and its Reset door opens a modal dialog inert to its own dismissal
while the chain runs. First run is zero-touch (the page FIRES the setup
chain), and recovery is ONE screen whose title IS the diagnosis. The standing
screens (**Update**, **Reset**, **How Your Server Runs**, **What macOS Will
Ask**, **Server Addresses**) never join `screensFor`'s list: they arrive by
REQUEST as a member of the closed `reset::Screen` enum, routed off
`REQUESTED_SCREENS` via `screenForRequest`; adding a screen means the Rust
enum and that list, and there is no third place to forget. ONE `update` screen
does both halves (`app-update` is deleted, not aliased). The window is
1024x720, fixed. The page re-probes every 1500 ms with no Refresh button,
skipping while an action is in flight, the window is hidden, or a hand is in
an input, so anything that must survive a render (`Show Details` openness, a
Copy flash, the reset step rows, the update selection) lives in PAGE state,
never in an element the rebuild throws away. `desktop_logs` takes NO argument
on purpose: a path parameter would be an arbitrary-file read reachable from a
page.

**Working on the assistant's screens, routing or the log panes: read
apps/server/desktop/docs/assistant.md first.**

## Who runs the server

Two modes: a service (launchd / systemd user unit, survives the app closing)
or this app as parent (`supervisor.rs`, dies with it). **The DISK
outranks the stored preference**, always in that direction
(`effective_supervision`): a preference that beat an installed definition
would have the app stop on quit a service it never started. The supervisor
answers a manager's questions the same way a manager does: respawn on any exit
after five seconds, **SIGTERM to the MAIN PID, never the process group** (the
group signal takes every live tmux pane with it), and it names itself through
`SUBSHELL_SUPERVISOR*`, which the server believes only when the pid is its own
parent. One load-bearing macOS login fact is UNMEASURED and must be confirmed
once: the doc names the probe, and the rest of the mode has no automated
coverage either.

**Working on supervision, the service modes or `supervisor.rs`: read
apps/server/desktop/docs/supervision.md first.**

## Updating in one act

One press updates the app AND the server that app ships, as **two phases
separated by the relaunch** (the app first, because the new app carries the
newer server). Replacing a managed copy runs
`<installed> update --from <sidecar> --yes --no-restart --json`: a
TRANSACTION the new binary completes or reverts at boot (backup,
`pending.json`, `.previous`), while a first install stays a plain copy, and a
server older than the `update` verb falls back to the copy with the missing
backup named on screen. The `PendingBundledInstall` marker is written BEFORE
the relaunch and never itself decides there is work; both update commands are
`wizard`-only, `desktop_install_app_update` taking exactly TWO booleans and no
strings. Force governs the pane-safety refusal ONLY and may never install an
older bundled CLI over a newer installed one. One publisher keypair for both
desktop apps: **losing `TAURI_SIGNING_PRIVATE_KEY` means every installed app
can never auto-update again**, and a local `bun run compile` needs a
(throwaway) private key set; `tauri dev` is unaffected.

**Working on any update path or the signing setup: read
apps/server/desktop/docs/updating.md first.**

## Resetting the machine

The dashboard's danger card may name a SCREEN
(`desktop_open_assistant({ screen: "reset" })`), never a path or a command;
the five deletion paths come all-or-nothing from the server's own
`status --json` `paths` block and are stashed in APP state before anything
mutates (the chain uninstalls the server that would otherwise be asked where
its own data lives). `desktop_reset` takes ONLY the typed hostname, and both
guards run before the first mutation: the shape rules (absolute, never `/`,
never `$HOME`) and the containment guard refusing any recursive delete that IS
or CONTAINS the managed `~/.local/bin/subshell-server`, canonicalized on BOTH
sides. The chain ends by `destroy()`-ing `main` (not `close()`) and restarting
the app ON THE MAIN THREAD, and **never close the assistant from inside the
chain**: it is the window the command runs in.

**Working on the reset chain or screen: read
apps/server/desktop/docs/reset.md first.**

## Native prerequisites

**`bun install` covers none of these, and the root README no longer keeps a
prerequisites list**: this section is the list. Every workflow that builds this app runs INSIDE
`ghcr.io/subshell-ai/desktop-builder:ubuntu24.04`
(`docker/desktop-builder.Dockerfile`), which already carries them, so CI can
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

macOS needs only the Xcode command-line tools: the system WebKit is what Tauri
links against there, so none of the packages above have a Homebrew counterpart.

**The minimum glibc is 2.39, by choice**, because the builder image is
ubuntu24.04, which excludes Ubuntu 22.04 and Debian 12. Building on an older
host is not a supported configuration; the root
`docs/release-and-ci.md` carries the reasoning and the lever.

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

## macOS permissions (spec 2026-09-14)

The `permissions` screen (macOS only) lists three rows, actionable first: it
REQUESTS Notifications and Photos, EXPLAINS Files-and-Folders (the prompt is
attributed to whichever process lists the folder), and never blocks Continue.
Tauri's notification plugin is a stub that answers `Granted`; the truth comes
from `UNUserNotificationCenter` / `PHPhotoLibrary` in `crates/desktop-core`,
behind a bundle guard that runs before every call: the UN API aborts a
non-bundle process, so `tauri dev` answers `unavailable` BY DESIGN. Both
states ride the probe, and the dashboard reads them through
`desktop_permissions` (read-only, argument-free, one of `main`'s seven);
everything that ACTS stays `wizard`-only and argument-free, and the Photos
request must hop to the MAIN THREAD through an injected dispatcher.
`wire-names.test.ts` pins the three crossing enums to Rust's spelling.

**Working on the permissions screen or commands: read
apps/server/desktop/docs/macos-permissions.md first.**

## Commands

```bash
# From the REPO ROOT, the command that builds the CLI and stages it first —
# and refreshes ~/.local/bin/subshell-server, which is what this app
# actually runs (the sidecar is on no rung of the ladder; root AGENTS.md):
#   bun run dev:desktop-server
bun run dev:app             # tauri dev (needs a staged sidecar — see below);
                            # runs `dev:ui` for you via beforeDevCommand
bun run dev:ui              # just the Vite dev server, on :5178
bun run build               # vite build -> ui/dist   (pure JS; safe in CI)
bun run compile             # tauri build --debug
bun run test                # bun test src ui/src  (the release script + the assistant,
                            # whose pure decisions are tested without a webview)
bun run verify-types        # both tsconfigs: src/ (bun) and ui/ (webview)
cd src-tauri && cargo test  # the Rust half — the ladder, the parsers, the policy
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings

# the shared half, and it needs no webview, no display and no Tauri system deps
cd ../../crates/desktop-core && cargo fmt --check \
  && cargo clippy --all-targets -- -D warnings && cargo test
```

The Rust half runs in CI as its own `desktop-rust` job in
`.github/workflows/test.yml`: it cannot ride `bun run test`, which runs on a
plain `ubuntu-latest` with no Rust toolchain and none of Tauri's system deps.
`crates/desktop-core` has neither constraint and is the half worth running
first: it compiles in seconds and carries the regression tests for every
measured bug below. **Its tests are a separate `cargo test` run**: the app's
does not reach a path dependency, so `cd src-tauri && cargo test` compiles the
shared crate without running a single one of its tests.

**Verify Linux-only lints in a container, not by reasoning.** Half this crate
is `#[cfg]`-gated, so `cargo clippy` on a Mac cannot see what Linux compiles:
a module gated at its CALL SITE rather than at the module is entirely dead code
there, and a `match` whose only other arm is `#[cfg(macos)]` collapses to one
arm plus a wildcard. Both failed CI after passing locally:

```bash
docker build -f docker/desktop-builder.Dockerfile -t desktop-builder:local .
docker run --rm -v "$PWD":/w -w /w desktop-builder:local bash -euc '
  rustup component add rustfmt clippy
  export CARGO_TARGET_DIR=/tmp/target
  cd /w/crates/desktop-core
  cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
  cd /w/apps/server/desktop/src-tauri
  install -m 755 /dev/null "binaries/subshell-server-bundled-$(rustc --print host-tuple)"
  cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test'
```

`--platform linux/arm64` on Apple silicon runs natively and answers the same
question: `#[cfg(target_os)]` does not care about the architecture.

**A clean checkout cannot compile this crate without a staged sidecar.**
`tauri-build` refuses to build when an `externalBin` file is missing, and
`binaries/*` is gitignored, so `cargo test` on a fresh clone fails with
`resource path … doesn't exist` before a single test runs. CI stages a
zero-byte STUB, which is all `tauri-build` checks for and all the Rust tests
need (none of them executes the sidecar). Locally, stage a real one with the
recipe below if you also want to run the app.

`bun run compile:release` (`src/scripts/release.ts`) is the release pipeline:
it builds the SERVER first and stages it as the sidecar, then bundles, asserts
the exact bundle set, GLOBS that bundle directory for the one artifact Tauri
wrote, digests and publishes into `dist-rel/`. CI drives it per shard from
`.github/workflows/release.yml`; the root `docs/release-and-ci.md` carries the
operator-facing version.

**The `build` script is the UI and nothing else: `vite build`, no Rust.**
What must stay out of the turbo `build` graph is CARGO. `lint.yml` runs BARE
on the fleet (bun and JS actions need no system libraries, and no fleet
runner is guaranteed a Rust toolchain), and it runs `bun run build` across
the workspace, so the Rust half stays reachable only through `compile`,
`compile:release` and `rust:check`, the same discipline
`apps/client/mobile` uses to keep Xcode out. (This paragraph used to name
hosted `ubuntu-latest` as the reason: stale since the fleet migration; the
constraint outlived the machine it named.) There is also **no
`dev` script**: root `bun run start` is `turbo watch dev`, which would
otherwise launch a Tauri window for everyone. This app's Vite port is
**5178** and `strictPort`: 5174 (`apps/server/web`) WALKS UPWARD when busy and
lands on 5175/5176, and 5177 is the client's, so this is the first port that
cannot collide, and `devUrl` is a fixed string, which only works when the
port is one.

## The staged sidecar

`bundle.externalBin` is `binaries/subshell-server-bundled`. The staged file
carries the **Rust** triple (`…-aarch64-apple-darwin`); Tauri **strips** that
suffix on copy, so inside the bundle (and beside the dev binary) it is just
`subshell-server-bundled` (`SERVER_SIDECAR.bundled_name` in
`src-tauri/src/server_bin.rs`).
Those are two different strings and both are needed: anything grepping for the
staged name inside a built bundle finds nothing, 100% of the time.

To stage one by hand for `tauri dev`:

```bash
SUBSHELL_SERVER_RELEASE_TRIPLES=darwin-arm64 \
SUBSHELL_SERVER_RELEASE_DIR="$PWD/apps/server/desktop/src-tauri/binaries" \
  bun run release:cli-server
cd apps/server/desktop/src-tauri/binaries \
  && mv subshell-server-cli-darwin-arm64 subshell-server-bundled-aarch64-apple-darwin \
  && rm -f subshell-server-cli-darwin-arm64.sha256
```

Three rules about that binary:

- **`compile:release`, never `compile`.** Only the release build embeds the SPA
  (`src/generated/embedded-web.ts`); the plain `compile` ships the tracked stub
  with `EMBEDDED = false`, and `selectStaticPlugin` then throws at boot on a
  user's machine, where there is no `apps/server/web/dist` to fall back to.
- **Delete the `.sha256` sidecar.** It describes the bytes BEFORE Tauri re-signs
  the nested binary with `--force`, so it is a lie the moment the `.app` is
  sealed. Digests are never comparable between the bare-binary download channel
  and this one.
- **Never pre-sign or separately notarize it.** Tauri signs nested binaries
  inside-out with the bundle's single entitlements slot, and the app-level
  notarization mints tickets for nested files. A pre-minted ticket binds to a
  cdhash Tauri is about to replace.

`binaries/*` is gitignored: it is a ~110 MB build input.

## Names

| | this app |
| --- | --- |
| `productName` (the `.app` a user installs) | `Subshell Server`: `Subshell Server.app`, space included |
| published macOS asset | `Subshell-Server-Desktop-<version>-darwin-arm64.dmg` |
| published Debian asset | `subshell-server-desktop_<version>_amd64.deb` |
| the CLI it bundles, as that CLI publishes it | `subshell-server-cli-<triple>` |
| bundle identifier | `dev.subshell.server` |
| Cargo crate / `/usr/bin` binary | `subshell-desktop` |
| sidecar stem | `subshell-server-bundled` |

Three things about that table are load-bearing:

- **The published names are this repo's choice, not the bundler's.**
  `desktopArtifactFileName` (`@internal/subshell-protocol`) picks them, and
  they are space-free because they are download URLs and shell arguments. What
  Tauri emits is DISCOVERED: `collectArtifact` globs `bundle/<dir>` for the one
  `.deb`/`.dmg` present (`selectBundleOutput`; zero or several is a refusal,
  never a pick) and renames it. Discovery rather than prediction: the `.deb`
  name goes through Debian's own package-name sanitizer and the `.dmg` name
  through Tauri's own versioning, neither knowable without running the bundler,
  which is what frees `productName` to carry a space. The `macos/` directory
  a DMG build also fills (the `.app` the image is made from, plus create-dmg's
  `share/` staging area) is a tolerated intermediate under `assertBundleSet`
  and is never published.
- **The `.app` inside the DMG keeps its space**; so does the mounted volume.
  A space in a bundle path is therefore a real case: the published image name
  is space-free, and `scripts/smoke-desktop-bundle.sh` mounts with `hdiutil`
  and quotes every path it builds from `PRODUCT`. Tauri only SIGNS the image
  (2.11.5: it notarizes/staples the `.app` and stops), so the pipeline runs
  `notarizeAndStapleDmg` between `collectArtifact` and the digest, and the
  smoke's `stapler validate` on the IMAGE is what proves that step happened.
- **The identifier is an identity, not a label.** It keys the macOS settings
  directory, the notification permission grant, the single-instance lock and
  the window-state store, and macOS tracks an app BY it; so it must stay
  distinct from `apps/client/desktop`'s `dev.subshell.client` (the two apps are
  installed side by side and must not share a settings file), and changing it
  is what makes a build a different app to macOS rather than an upgrade of this
  one. The crate name is the same class of decision (it is the `/usr/bin`
  binary in the `.deb`, beside `apps/client/desktop`'s), and so is the sidecar
  stem, which names the binary this app WRAPS rather than the app; neither is
  renamed in step with the product.
  `src/scripts/__tests__/release.test.ts` pins `productName` against the
  protocol constant and the identifier against its expected value;
  `src-tauri/src/lib.rs` pins the settings paths it keys.

## Where things live

```
src-tauri/src/
├── lib.rs         # plugins, command registration, setup (boot PROBEs, resumes an interrupted update, opens `main` or `wizard`, spawns the watch)
├── windows.rs     # the two windows, the 360x240 floor, the UA marker with its `b=` group
├── watch.rs       # the 5s poll: the tray's state, and re-pointing `main` when the origin moves
├── control.rs     # the tauri commands — argument-poor wrappers over the CLI; open_home; ACTION_IN_FLIGHT
├── reset.rs       # the reset screen's Rust side: the closed Screen enum, the stashed plan, the two guards, the chain
├── supervisor.rs  # running the server as THIS APP'S child: the respawn loop, the stop that blocks, the signal discipline
├── server_bin.rs  # the ladder, ExecStart parsing, bundled-vs-installed policy, SERVER_SIDECAR
├── bridge.rs      # the DesktopAction enum and the eval dispatch
├── menu.rs        # the macOS menu bar
├── about.rs       # the native About panel: pure metadata assembly + the Linux one-item window menu
└── tray.rs        # the tray icon and its menu, including the close-to-tray check item
```

The assistant is TypeScript on Vite with Tailwind (since 2026-09-10; the
plain-JS original had no build step, which apps/server/desktop/docs/ipc-boundary.md
explains).
**One HTML input, one build, one bundle**: the second input went with the
console, and `vite.config.ts` names the remaining one explicitly rather than
leaning on Vite's `index.html` default, because a default that found nothing
would ship a bundle in which `WebviewUrl::App` resolves to a 404 with no build
error anywhere. `tauri-config.test.ts` pins that there is exactly one, and that
no orphan `index.html` sits beside it.

## What the page is made of

`lib/` holds anything with a contract rather than a rendering: pure
decisions, testable without a webview; `screens/` holds only rendering. **No
screen imports `host.tsx`** (a module-eval cycle reads as a BLANK window on
the machine someone is repairing), and Tauri is reached only through
`lib/ipc.ts`. About is native, owns no strings of its own, and needs no
command at all.

**Working on the `ui/` tree or moving logic between `lib/` and `screens/`:
read apps/server/desktop/docs/page-structure.md first.**

## The IPC boundary

`src-tauri/permissions/desktop.toml`'s EXISTENCE is the boundary: without it
Tauri leaves every app command ungated for every local window. The split is
window KIND: `wizard` holds the twenty-four its page invokes; `main` holds
exactly SEVEN plus window dragging, answered only from a TRUSTED origin:
loopback (either spelling, http, any port) or the configured `APP_BASE_URL`.
`remote.urls` is a wildcard; `trust.rs` at the invoke handler is the boundary,
and its flag is armed only by a COMMITTED main-frame load, never a navigation
request, never a subframe. Page-facing arguments are closed enums, paths, or
booleans: never a URL, never a shell word (`desktop_open_in_browser` takes a
PATH and joins it onto the pinned origin), and `ipc-acl.test.ts` pins the
three-way contract (calling page, `desktop.toml`, capability file) with
exact sets, so a new command is loud or absent, never half-granted.
`withGlobalTauri` and the UA marker ship as a pair or the dashboard bridge
dies SILENTLY; `bun run dev:desktop-server` points `main` at the SPA's Vite on
:5174, because otherwise an `apps/server/web` edit reaches that window not
slowly but not at all.

**Working on the IPC boundary or adding a command: read
apps/server/desktop/docs/ipc-boundary.md first.**

## The watch thread, and getting windows in front

One thread (`src-tauri/src/watch.rs`) probes every five seconds for the life
of the app, and its duty is re-pointing `main` when the server's origin moved.
Three rules it keeps: it SKIPS while `control::ACTION_IN_FLIGHT` is held (a
probe landing mid-chain reports a half state), it skips entirely when there is
no `main` window, and it NEVER raises the assistant: a server that goes away
shows the SPA's own offline banner; the person reaches recovery through the
pill, tray or Dock. On the windows side: **`show` + `unminimize` +
`set_focus` does not raise a window on Linux** (Wayland refuses the
activation), so every raise goes through `windows::raise`; nothing tucks
anymore: assistant and dashboard legitimately coexist; and the window-state
plugin restores `main` only: the assistant's fixed frame is DENYLISTED,
because `open_main` inherits its size and position.

**Working on `watch.rs` or `windows.rs`: read
apps/server/desktop/docs/windows.md first.**

## Native chrome

Close-to-tray is gated on a tray CAPABILITY probe, not the platform (where no
StatusNotifier host answers, hiding the window hides it forever; the check
item is seeded from the clamped value, and muda's pre-event flip is READ via
`is_checked()` rather than toggled). `PredefinedMenuItem::{cut,copy,paste,select_all}`
come FIRST in the Edit menu or ⌘C/⌘V do not work at all in a Tauri macOS
webview. Text size is a Rust-owned zoom ladder (`desktop-core`'s `zoom`), with
the two menus' shared ids routed in exactly ONE place: a Tauri menu event is
GLOBAL, and matching ids in two handlers steps the ladder twice per click.
Notifications are native and edge-triggered off the SSE feed the app already
reads, and the title bar is a HANDSHAKE, not a version check: `main` starts
hidden and the SPA asks for the overlay, six-second decorated fallback. The
tray is a shortcut, never the only route.

**Working on the menu, tray, zoom, notifications or title bar: read
apps/server/desktop/docs/native-chrome.md first.**

## Things that will bite

- **A GUI app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.** No `/opt/homebrew/bin`,
  no `~/.local/bin`. `service install` runs a tmux preflight through an injected
  `which`, AND bakes `Environment=PATH=` from the installing process; so
  without `desktop-core`'s `shell_env` you get either a refusal or, worse, a
  service that installs cleanly and then cannot launch a single pane. Every
  spawn goes through `proc::run`, which injects the login PATH.
- **`execLine()` records two tokens for a dev-form install.**
  `ExecStart=/path/to/bun /repo/apps/server/api/src/index.ts`. Anything reading a
  service definition must carry both or it runs bun with nothing to run.
- **`disable_drag_drop_handler()` on `main` is load-bearing.** Tauri's native
  file-drop handler otherwise swallows HTML5 drag events, which silently breaks
  both drag-a-subshell-into-a-workspace (the `application/x-subshell-id`
  payload) and the terminal's own file-drop uploads.
- **`min_inner_size` is 360×240, a third of what it was.** It used to be
  1024×640, pinned to `useIsWide()` (`matchMedia("(min-width: 1024px)")`),
  so the app could never render the SPA's phone drawer. That floor is gone on
  purpose: it made a window nobody could park beside an editor, and the narrow
  chrome below the breakpoint is a designed layout, not a broken one. The
  breakpoint itself has not moved.
- **Never downgrade the installed server.** Boot runs
  `migrator.migrateToLatest()`, which is forward-only. `decide_server` offers a
  newer bundled server and ADOPTS a newer installed one; the reverse is data
  loss, not a choice to present.
- **Icons** come from `brand/` in two steps and never by hand:
  `bun run brand:generate` writes the wordmark into BOTH desktop apps'
  `ui/public` (each has its own Vite asset root, so each needs its own copy)
  and this app's 1024px master to
  `src-tauri/icons/app-icon.png`, then `bun run icons` cuts the `.icns` and the
  sized PNGs from it. The background colour that distinguishes this app from
  `apps/client/desktop` lives in `brand/generate.ts`'s `DESKTOP_APPS` table.
  The master is a ROUNDED one, not `apps/server/web/public/icons/icon-512.png`:
  that is the square web tile, and cutting the `.icns` from it ships a macOS
  icon with hard corners.
- **The tray icon is NOT a template** (`icon_as_template(false)`). macOS draws a
  template from the alpha channel alone and discards every colour, which would
  render this app and the node app as the same filled rounded square, and,
  since the asset is a 96%-opaque tile, as a blob rather than the `/s` mark. A
  coloured menu-bar icon does not adapt to a light or dark bar; a dark plate
  with a light glyph reads on both.

- **`proc::run` drains both pipes on threads, and that is not tidiness.**
  Waiting for exit and reading afterwards is the classic pipe deadlock, and it
  failed in both directions here (measured): 128 KiB of stdout turned a 5 ms
  command into a 3 s "timeout" with the child SIGKILLed, and a command leaving
  a backgrounded descendant held the pipe open so a 2 s deadline returned after
  8 s with `timed_out: false`. Both are regression tests now.
- **Nothing in `desktop-core`'s `shell_env` may use `Command::output()`.** It runs the user's
  own login profile (arbitrary code, on every launch) inside the `OnceLock`
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
- **macOS Login Items attributes a legacy LaunchAgent to the SIGNING
  ORGANIZATION** unless the plist declares the app, so an install without
  `AssociatedBundleIdentifiers` shows as "Disaresta, LLC" with no icon, which
  users read as malware, not as their own server. The plist template
  (`apps/server/api/src/service.ts`) declares `dev.subshell.server`, the one
  string that `DESKTOP_SERVER_BUNDLE_ID` (protocol), the plist label and this
  app's `identifier` all share; pin tests on both sides hold them together,
  because if they drift the association detaches silently and nothing errors.
- **`service status` reports launchd/systemd VERBATIM, and the page passes
  it through.** `launchd: spawn scheduled` is the crash-throttle wait: the
  service IS the one you installed and it IS trying; a manager command that
  fails for any reason other than "Could not find service" (exit 113) answers
  `state: unknown` with the stderr in `detail`, which the page shows in
  red. A manager that would not answer is not the same fact as a stopped
  service, and flattening the two is how the 2026-09-07 crash loop read as
  "stopped" with no explanation.
