# Desktop AGENTS.md

`apps/server/desktop` (`@internal/desktop-server`) — **Subshell Server**, a
**Tauri v2** shell that installs, runs and manages a `subshell-server` on this
machine, so a user never has to touch a CLI binary.

## The three windows, and why they are three

| Window | Page | Why |
| --- | --- | --- |
| `wizard` | `ui/dist` (Vite output; sources in `ui/src/`), bundled, `tauri://` | Owns first run: a guided chain from virgin machine to running server, on a page that must render with nothing installed. |
| `console` | same bundle, `index.html` | Must render with the server **down**, and is the only surface allowed to drive the CLI. Owns repair, settings, and the reset view — four sections behind a sidebar (below). |
| `main` | the SERVER's own SPA over `http://127.0.0.1:<port>` | `apps/server/web` is hard same-origin. |

Both local pages are the same Vite build (two rollup inputs, one `ui/dist`,
one CSP) and the same ACL rule: **CLI-driving commands are granted to bundled
pages only**. What splits them is lifecycle, not privilege — the wizard is the
first-run flow and nothing else ("Run setup again" is what reset is), and the
console is the surface a machine returns to once `onboarded` says it has been
set up. Raising one retires the other (below).

**`main` never loads a bundled copy of the SPA.** `src/lib/api.ts` fetches
root-relative with `credentials: "include"`, `src/lib/auth-client.ts` sets no
`baseURL`, `src/lib/use-subshell-ws.ts` builds its WebSocket URL from
`window.location.host`, and there are zero `import.meta.env` reads in the whole
frontend. A `tauri://localhost` page cannot carry the `SameSite=Lax; httpOnly`
session cookie to any of them, and admin routes reject bearer keys by design —
so serving the SPA ourselves would mean an auth rework, not a build change.

## Boot looks before it leaps

`setup()` runs one `boot_probe` and THEN chooses the window, from the fresh
probe rather than the stored flag: `boot_window(&Probe)` returns the wizard
while `onboarded` is false and the console once it is true (R6). The order is
the whole point: a machine set up entirely from the CLI opens the CONSOLE on
its first app launch, because the boot probe answers `ready` and marks the
flag before the branch runs — the wizard is never shown on a machine that is
already running.

`mark_onboarded` is the SINGLE writer of the flag (R16), and the only thing
that sets it is a probe whose decision is `ready`. What `onboarded: false`
means is exactly "this app has never seen setup complete on this machine" —
not "this machine is empty" (the probe is the authority on that, and it stays
the authority on every later tick). Reset is the only other thing that moves
the flag, back to false, as its last disk act.

Every opener of the manage surface — tray, menu, the SPA's pill, the
single-instance and Dock handlers — goes through `open_manage_window`, which
branches on the same stored flag and closes the window it supersedes. The
branch lives in one function so a machine can never have its manage window
decided in two places.

## The setup assistant

Three screens in one fixed frame (spec 2026-09-11, which superseded the
six-step wizard of 2026-09-10 § 5): Welcome, Install tmux (shown only while
tmux is missing, and it advances itself the moment the poll sees one), and
Set Up Your Server, whose press replaces the screen with a progress
checklist and then opens the dashboard by itself. `screensFor(probe)` decides
which screens exist, `dots(probe, screen)` where the six dots stand,
`setupRows`/`canSetup`/`failureLine` the checklist, the gate and the failure
line, all in `ui/src/lib/wizard-state.ts`, pure and tested without a
webview. There is no rail, no Done screen and no log pane: a failed chain
shows the CLI's last stderr line under the failed row and the verbatim
output behind a collapsed Show Details. Agents are not asked about here; the
SPA's `/setup` owns that question, because detection lives in the server.
The window is 1024×720 and not resizable, and `open_main` takes its position
and size when the dashboard is created, so the swap reads as one window
changing screen; the SPA continues the dot row (six dots, three filled) when
it sees the desktop UA marker.

## Resetting the machine

Entry is the dashboard's Settings danger card (admin + desktop marker,
`apps/server/web`); confirmation and execution are the CONSOLE's. The remote
page may name a SCREEN, never a path or a command:
`desktop_open_console({ screen: "reset" })` parses a closed enum, and
`reset::arm_and_raise` then reads the machine NOW — the five deletion paths
come from the server's own `status --json` (the `paths` block, which is why
that CLI field exists), all-or-nothing: a partial block is refused exactly
like no block, because a subset deleted and reported success is the R1 shape
with a typed hostname in front of it (R17). The plan lives in app state
(`reset::Stash`), not on the page and not re-read mid-chain: the chain stops
and uninstalls the very server whose report names the paths, so asking it
afterward would be asking a dead server where its own data lives (R18). A
half-run leaves the plan stashed — Retry converges.

`desktop_reset` takes ONLY the typed hostname, compared against the one
memoized `machine_hostname()` the screen was rendered from (R15: displayed
value, comparison value, single OnceLock). Two guards, both before the first
mutation: every target passes the shape rules (absolute, never `/`, never
`$HOME`), and the single containment guard refuses any recursive delete that
IS or CONTAINS the managed `~/.local/bin/subshell-server` — with BOTH sides
canonicalized, because a prefix test between a symlinked and a real spelling
passes while the delete still reaches the binary (P3). The default data dir
EQUALS the config dir that holds config.env and that is legal (R13) — the
config file is a deletion target, not a keepsake; only the binary is kept.

The order is the confirmation screen's: stop, close the pane servers,
uninstall, delete (database file, pane logs, node artifacts, data dir minus
config.env, config.env last), clear this app's choices, move the windows —
close `main`, open the WIZARD, close the console LAST, because a zero-window
moment mid-command is how a reset could quit the app instead of landing the
human in setup. Pane closing goes through tmux's OWN directory rule —
`TMUX_TMPDIR ?? /tmp`, symlink-resolved, `tmux-<uid>/`, and only `subshell-*`
sockets (R1). `cleanSocket` used to join `TMPDIR`, which on macOS names a
per-user `/var/folders` path with no sockets in it; that silent-miss class is
why the rule is one exported function there now (`tmuxSocketPath`,
pane-runtime). The `subshell-` prefix that decides WHICH sockets a reset may
kill is pinned between the two languages by containment — an `include_str!`
test in `reset.rs`, the way the installer table pins its TypeScript twin.

Channel discipline is `desktop_setup`'s, inherited: an in-chain failure
answers `Ok(ActionResult { ok: false, stdout: log, stderr })` with every word
the CLI said up to the stop — `Err` belongs only to refusals that fire before
anything mutated. The console renders the half-run's log where the human
still is, styled as a failure, with the button re-labelled Retry.

The deep link's true worst case, stated so it survives someone checking it
(spec R21): an XSS in a control plane's SPA can raise this app's window to
the reset confirmation, and reaches exactly one read-only command the app
already runs on a timer, and no verb that changes the machine — execution
still needs the hostname typed into a box.

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
# and refreshes ~/.local/bin/subshell-server, which is what this app
# actually runs (the sidecar is on no rung of the ladder; root AGENTS.md):
#   bun run dev:desktop-server
bun run dev:app             # tauri dev (needs a staged sidecar — see below);
                            # runs `dev:ui` for you via beforeDevCommand
bun run dev:ui              # just the Vite dev server, on :5178
bun run build               # vite build -> ui/dist   (pure JS; safe in CI)
bun run compile             # tauri build --debug
bun run test                # bun test src ui/src  (the release script + the console,
                            # whose pure decisions are tested without a webview)
bun run verify-types        # both tsconfigs: src/ (bun) and ui/ (webview)
cd src-tauri && cargo test  # the Rust half — the ladder, the parsers, the policy
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings

# the shared half, and it needs no webview, no display and no Tauri system deps
cd ../../crates/desktop-core && cargo fmt --check \
  && cargo clippy --all-targets -- -D warnings && cargo test
```

The Rust half runs in CI as its own `desktop-rust` job in
`.github/workflows/test.yml` — it cannot ride `bun run test`, which runs on a
plain `ubuntu-latest` with no Rust toolchain and none of Tauri's system deps.
`crates/desktop-core` has neither constraint and is the half worth running
first: it compiles in seconds and carries the regression tests for every
measured bug below. **Its tests are a separate `cargo test` run** — the app's
does not reach a path dependency, so `cd src-tauri && cargo test` compiles the
shared crate without running a single one of its tests.

**Verify Linux-only lints in a container, not by reasoning.** Half this crate
is `#[cfg]`-gated, so `cargo clippy` on a Mac cannot see what Linux compiles —
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
`binaries/*` is gitignored — so `cargo test` on a fresh clone fails with
`resource path … doesn't exist` before a single test runs. CI stages a
zero-byte STUB, which is all `tauri-build` checks for and all the Rust tests
need (none of them executes the sidecar). Locally, stage a real one with the
recipe below if you also want to run the app.

`bun run compile:release` (`src/scripts/release.ts`) is the release pipeline:
it builds the SERVER first and stages it as the sidecar, then bundles, asserts
the exact bundle set, GLOBS that bundle directory for the one artifact Tauri
wrote, digests and publishes into `dist-rel/`. CI drives it per shard from
`.github/workflows/release.yml`; the root `AGENTS.md` carries the
operator-facing version.

**The `build` script is the UI and nothing else: `vite build`, no Rust.**
What must stay out of the turbo `build` graph is CARGO. `lint.yml` runs BARE
on the fleet — bun and JS actions need no system libraries, and no fleet
runner is guaranteed a Rust toolchain — and it runs `bun run build` across
the workspace, so the Rust half stays reachable only through `compile`,
`compile:release` and `rust:check`, the same discipline
`apps/client/mobile` uses to keep Xcode out. (This paragraph used to name
hosted `ubuntu-latest` as the reason — stale since the fleet migration; the
constraint outlived the machine it named.) There is also **no
`dev` script**: root `bun run start` is `turbo watch dev`, which would
otherwise launch a Tauri window for everyone. The console's Vite port is
**5178** and `strictPort`: 5174 (`apps/server/web`) WALKS UPWARD when busy and
lands on 5175/5176, and 5177 is the client's, so this is the first port that
cannot collide — and `devUrl` is a fixed string, which only works when the
port is one.

## The staged sidecar

`bundle.externalBin` is `binaries/subshell-server-bundled`. The staged file
carries the **Rust** triple (`…-aarch64-apple-darwin`); Tauri **strips** that
suffix on copy, so inside the bundle — and beside the dev binary — it is just
`subshell-server-bundled` (`SERVER_SIDECAR.bundled_name` in
`src-tauri/src/server_bin.rs`).
Those are two different strings and both are needed: anything grepping for the
staged name inside a built bundle finds nothing, 100% of the time.

To stage one by hand for `tauri dev`:

```bash
SUBSHELL_SERVER_RELEASE_TRIPLES=darwin-arm64 \
SUBSHELL_SERVER_RELEASE_DIR="$PWD/apps/server/desktop/src-tauri/binaries" \
  bun run release:server
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

`binaries/*` is gitignored — it is a ~110 MB build input.

## Names

| | this app |
| --- | --- |
| `productName` (the `.app` a user installs) | `Subshell Server` — `Subshell Server.app`, space included |
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
  through Tauri's own versioning, neither knowable without running the bundler
  — which is what frees `productName` to carry a space. The `macos/` directory
  a DMG build also fills (the `.app` the image is made from, plus create-dmg's
  `share/` staging area) is a tolerated intermediate under `assertBundleSet`
  and is never published.
- **The `.app` inside the DMG keeps its space** — so does the mounted volume.
  A space in a bundle path is therefore a real case: the published image name
  is space-free, and `scripts/smoke-desktop-bundle.sh` mounts with `hdiutil`
  and quotes every path it builds from `PRODUCT`. Tauri only SIGNS the image
  (2.11.5 — it notarizes/staples the `.app` and stops), so the pipeline runs
  `notarizeAndStapleDmg` between `collectArtifact` and the digest, and the
  smoke's `stapler validate` on the IMAGE is what proves that step happened.
- **The identifier is an identity, not a label.** It keys the macOS settings
  directory, the notification permission grant, the single-instance lock and
  the window-state store, and macOS tracks an app BY it — so it must stay
  distinct from `apps/client/desktop`'s `dev.subshell.client` (the two apps are
  installed side by side and must not share a settings file), and changing it
  is what makes a build a different app to macOS rather than an upgrade of this
  one. The crate name is the same class of decision (it is the `/usr/bin`
  binary in the `.deb`, beside `apps/client/desktop`'s), and so is the sidecar
  stem, which names the binary this app WRAPS rather than the app — neither is
  renamed in step with the product.
  `src/scripts/__tests__/release.test.ts` pins `productName` against the
  protocol constant and the identifier against its expected value;
  `src-tauri/src/lib.rs` pins the settings paths it keys.

## Where things live

```
src-tauri/src/
├── lib.rs         # plugins, command registration, setup (boot PROBEs, then opens `wizard` or `console`)
├── windows.rs     # the three windows, the 1024px floor, the UA marker, open_manage_window's branch
├── control.rs     # the tauri commands — argument-poor wrappers over the CLI
├── reset.rs       # the reset screen's Rust side: the stashed plan, the two guards, the chain
├── server_bin.rs  # the ladder, ExecStart parsing, bundled-vs-installed policy, SERVER_SIDECAR
├── bridge.rs      # the DesktopAction enum and the eval dispatch
├── menu.rs        # the macOS menu bar
└── tray.rs        # the tray icon and its menu
```

The console and the wizard (TypeScript on Vite with Tailwind since 2026-09-10;
the plain-JS original had no build step, which the section on the CSP
explains). Two HTML inputs, one build, one bundle:

```
ui/
├── index.html          # console shell; every id the page binds is in it (the sidebar + four sections, and #reset-view)
├── wizard.html         # wizard shell; rail + one screen
├── src/
│   ├── main.ts         # console ENTRY: state, render(), guard(), the poll, the sidebar
│   ├── console/        # the console's DOM, one module per concern (see below)
│   ├── wizard.ts       # wizard screens and navigation — DOM only; every judgment is imported
│   ├── styles.css      # @theme tokens + component classes; Tailwind in markup
│   ├── lib/
│   │   ├── ipc.ts      # one typed function per `desktop_*` command
│   │   ├── config-form.ts   # the pure form contract (see below)
│   │   ├── console-nav.ts   # the console's pure decisions: sections, Addresses availability, the hero's word
│   │   ├── installers.ts    # the pure install plans (see below)
│   │   ├── wizard-state.ts  # the wizard's pure decisions: landing step, gates, checklist rows
│   │   └── reset.ts         # the reset screen's pure decisions: rows, refusal, arming
│   └── __tests__/      # pure pins: config-form, console-nav, installers, wizard-state, reset, ipc-acl, tauri-config
└── dist/               # `frontendDist` — built, gitignored, never hand-edited
```

The split rule the plain-JS version established still decides WHERE logic
lives: anything with a contract rather than a rendering goes in `lib/`, where
it is testable without a webview. Everything under `ui/src/console/` holds only
the DOM.

## The console is four sections behind a sidebar

Spec `2026-09-11-server-console-sidebar-design.md`. The page was one scroll of
five cards — a status chip over a nine-row fact list, the step card, the tray
switch, a 220px log pane and a Danger zone disclosure, all on screen at once
with nothing to choose between them. It is a 200px sidebar and a content
column now: **Overview**, **Addresses**, **Logs**, **Settings**, one visible at
a time, in a 900x640 window (min 720x520).

```
ui/src/console/
├── state.ts           # the shared state object, the ConsoleHost contract, el()/slots()
├── hero.ts            # Overview's three lines: state word, version, address
├── steps.ts           # STEPS, the action guards, the tmux gate — everything the probe implies
├── facts.ts           # Overview's Details list
├── result-strip.ts    # one line saying what the last press did
├── config-form-view.ts# buildForm(), shared by the `init` step and Addresses
├── addresses.ts       # the Addresses section: availability, seeding, the save
├── logs.ts            # the two-tab pane, the tail, show()
├── settings.ts        # the tray preference
├── tmux-warning.ts    # the amber gate explanation — a FACTORY, one per gated surface
└── reset-view.ts      # the takeover, unchanged in behaviour
```

Five things about that arrangement are load-bearing:

- **No module under `console/` imports `main.ts`.** They take a `ConsoleHost`
  (`render`, `refresh`, `guard`, `goTo`, `fail`) instead. A cycle back to the
  entry is not a type error or a lint error — it is a temporal dead zone at
  module evaluation, i.e. a BLANK window on the machine someone is repairing.
  `guard()` stays in the entry because it owns busy, the problem line and the
  re-probe, which are the page's rather than a section's.
- **`configure` is no longer a step.** It was one the USER chose, held in an
  `override` beside `probe.next`, and it replaced the page's one card in
  place — so the way back was a Cancel button and the way in was a button four
  steps had to remember to list. `addressesAvailability` (`lib/console-nav.ts`,
  pure and tested) now answers "can a save work here" once, and the section
  renders the refusal itself. **No sidebar item is ever disabled**: a dimmed
  item with its reason in a tooltip breaks this console's rule that a refused
  control names its reason beside it, on every platform where hover is not a
  thing a person does.
- **Only the CURRENT section renders**, which is why `tmux-warning.ts` is a
  factory. Two surfaces gate on tmux (Overview's setup actions, the Addresses
  save); one element moved between them would belong to whichever rendered
  last, and the other would silently lose its explanation.
- **The result strip replaced the output pane's proximity.** A command's words
  used to land in a pane directly under the buttons, and `show()` stole that
  tab on its own. The pane is a section away now, so a press gets one line
  where it happened — "Restart: done.", or the failure — with "Show output"
  as the only thing that moves the Logs tab. `guard()` takes the button's
  LABEL for exactly this.
- **`.content` carries `min-width: 0`.** A grid item's automatic minimum size
  is its min-content width, so one long log line widened the `1fr` track and
  pushed the window's right edge out instead of scrolling inside the pane.
  Measured on the Logs section, where every line is long.

Settings re-reads the tray probe on every ENTRY, not once at boot: that probe
is deliberately not memoized in Rust (installing the AppIndicator extension
flips its answer with the app already running), and a boot read that failed
used to leave the group hidden with nothing to re-open it.

Everything that is NOT `tauri`-typed lives outside the app, in
`crates/desktop-core` (`subshell-desktop-core`), shared with
`apps/client/desktop`:

```
crates/desktop-core/src/
├── proc.rs        # every spawn: login PATH + a deadline
├── shell_env.rs   # the PATH a GUI app does not have
├── settings.rs    # three fields, one JSON file, path keyed by SettingsPaths
├── sidecar.rs     # installing a shipped binary atomically, named by SidecarSpec
├── tray.rs        # is a tray icon actually drawn here? (the close-to-tray gate)
└── version.rs     # semverLt, mirrored from the protocol package
```

Two things stay behind on purpose. `server_bin.rs` is a ladder for
`subshell-server` specifically, down to the unit file it reads and the plist it
parses. `control.rs`/`windows.rs`/`tray.rs`/`menu.rs`/`bridge.rs` are
`tauri`-typed and label-driven, and Subshell Client's window model is genuinely
different — duplication there is cheaper than an abstraction designed against
one real consumer and one guess.

The two per-app parameters are the ones that touch a user's disk:
`SETTINGS_PATHS` in `lib.rs` (`dev.subshell.server` / `subshell-desktop-server`
— the Linux name is prefixed to stay out of `~/.config/subshell-server`, the
server CLI's own `config.env` home) and `SERVER_SIDECAR` in `server_bin.rs`
(the bundled name, the installed name, and the `"subshell-server "` prefix its
`version` line starts with). Both are pinned by test, because changing either
does not fail — it silently starts the app from scratch against a different
file.

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
| `console` | every command — it is the control surface, and the only holder of the destructive ones (`desktop_reset` included) |
| `wizard` | probe, setup, install tmux, set the binary, open tmux docs, open main, open the console, and the dialog plugin's open — no service verbs, no bare `init`, no logs, no settings |
| `main` | `desktop_open_console`, `desktop_shell_ready`, `desktop_notify`, and window dragging — over loopback only |

`main`'s three are chosen for what they cannot do: show a window that already
exists, drop this app's own title bar, and display one notification with a
fixed shape. Nothing that touches the CLI, the config, the service or the
filesystem is reachable from a page the server serves. `desktop_open_console`
gained an OPTIONAL `screen` argument (spec § 7.1) — still one of the three,
still cannot execute anything: on the `reset` screen it performs one
read-only `status --json` spawn the app already runs on its own five-second
poll, and the execution behind it needs a hostname typed into the console's
own box.

**`withGlobalTauri` is load-bearing for `main`, not for the console.** The
SPA's desktop bridge (`apps/server/web/src/lib/desktop.ts`) reads
`window.__TAURI__` — it imports nothing — and it takes its desktop branch
because `windows.rs` marks `main`'s user agent `SubshellDesktop/…`. Turning
the global off while the marker ships kills the title-bar handshake, the
"Manage server" pill, native notifications and window dragging, and kills
them SILENTLY: the bridge never throws and the ACL stays green. Subshell
Client ships `false` precisely because it strips the marker. The pair, not
either half, is what `tauri-config.test.ts` pins.

**The three-way contract is pinned, because nothing else catches it.** A
command name lives in the calling page module, in `permissions/desktop.toml`
and in a capability file; missing from any one is a runtime permission
refusal, not a compile error. `ui/src/__tests__/ipc-acl.test.ts` asserts the
set of commands invoked from the CONSOLE page — `ui/src/main.ts` plus every
module under `ui/src/console/`, not the `main` window, which holds and must
keep holding only its three — equals the set `console.json` grants, that `ui/src/wizard.ts` invoked
equals what `wizard.json` grants, that no capability names an undefined
permission, that no defined permission goes ungranted by the union of the
three capability files, and that `main` still holds exactly its three
commands plus window dragging — "three" is a number worth a test, because "a
few harmless ones" is how a boundary erodes. Equality is asserted PER PAGE
rather than against all of `ipc.ts` because two local pages now share that
module: a whole-file equality test would slowly become the union of two
windows' surfaces, which is the exact shape this file exists to prevent. It
caught one stray on the day it was written: `allow-desktop-open-console` sat
in `console.json` although no console code path invokes it (the command
belongs to `main` and to the wizard's Done screen); the console's grant is
gone.

**The opener surface is the same rule with paths.** `desktop_open_path` takes
a CLOSED enum (`config-env | server-dir | service-definition | logs`), never a
path — the page names an intent and the Rust side re-reads the path from its
own fresh probe, so a row can only ever reveal the fact it is showing (the
client's `node_open_path` for the same reason). `logs` is answered entirely by
the CLI's `service status --json → logPath`: a null is the journal-hint case,
an absent field is an old server, and the console never re-derives a platform
path. `desktop_open_control_plane` opens the server's own `APP_BASE_URL` in the
SYSTEM browser (the address may name a LAN host the privileged `main` window
is deliberately never pointed at) — no URL crosses the IPC boundary from the
page, and the re-read value must be http(s). Both commands are console-only;
`main` gains neither. The `opener:allow-reveal-item-in-dir` grant in
`capabilities/console.json` covers the plugin side; the app commands are gated
by their own permission entries here.

`main`'s page is served by the subshell-server this app manages, so it is
treated as remote content. `capabilities/main.json` carries `remote.urls`
scoped to loopback, and `open_main` additionally refuses a non-loopback origin
and pins `on_navigation` to the origin it was opened with — three independent
gates, because the window holds privileged globals.

The console has a real CSP (`script-src 'self'`), which is why its logic is a
module rather than an inline script. The page is TypeScript built by Vite into
`ui/dist` (2026-09-10), and the build step moved INSIDE the promise the
plain-JS version made — `tauri dev` and `tauri build` run `dev:ui`/`build` as
their own before-hooks, so there is no way to launch or bundle the app that
skips it. `app.security.devCsp` relaxes the policy for `tauri dev` ONLY
(Vite's HMR injects an inline script and a style tag and needs its `ws://`
socket — production ships untouched). The build keeps its half of the
pairing — `modulePreload: { polyfill: false }`, `assetsInlineLimit: 0`,
`base: "./"` — because the production CSP would silently block an inline
polyfill or a `data:` asset, and `ui/src/__tests__/tauri-config.test.ts`
pins both halves against each other: a "cleanup" that re-enables either
breaks the console with no error anywhere.

**What the configure form SENDS is a contract, not a rendering.** A save is a
non-interactive `init --yes`, and `configure` resolves every key it was given no
flag for to that key's STORED value, so what the form sends decides whether a
save preserves config.env or rewrites it, and both ways of getting it wrong are
silent. `ui/src/lib/config-form.ts` holds the pure halves (`effectiveForm`,
`explicitFields`, `derivedBaseUrl`, `configPayload`, `fieldProblems`) and
`ui/src/__tests__/config-form.test.ts` covers them beside the source. (They
lived OUTSIDE `ui/` while `frontendDist` was `../ui`, because that whole
directory was copied into the shipped bundle and a test importing `bun:test`
would have shipped inside the installed app. The asset root is a Vite output
now, so source-beside-source is the layout again, and what keeps the old
failure mode from returning is `tauri-config.test.ts` pinning
`frontendDist === "../ui/dist"` — the shipped directory is generated, and a
test file cannot hide inside a build's output.) `package.json`'s `test` runs
`bun test src ui/src`; that same file also pins the wiring in `main.ts` at the
source, because the render path imports Tauri and cannot be loaded here.

The fields are PREFILLED with the effective configuration (2026-09-09), which
moved that contract rather than removing it:

- **Blankness used to mean "nobody chose this"**, which is how the CLI was told
  to keep deriving a value. A filled form cannot say that, so `explicitFields`
  does: a field is sent only when its `status --json` `source` is something
  other than `default`, or the user has typed in it since. `configPayload`
  sends an empty string for anything else, and the Rust side turns that into an
  omitted flag.
- **It keys on CHOSEN, not on EDITED, and the difference is a data-loss bug.**
  `trusted_origins` is the one emptyable flag: empty means "no extra
  addresses". Keyed on editing alone, opening the form and saving without
  touching that field sends empty and WIPES a stored list. So a value already
  in config.env is sent even when untouched.
- **`trustedOrigins` is never prefilled.** Its default is
  `DEFAULT_TRUSTED_ORIGINS`, the two dev Vite origins, which as a suggestion to
  someone configuring an instance would be actively misleading. Its label says
  `(optional)` and it stays blank.
- **A prefilled base URL follows the port while nobody has edited it**
  (`derivedBaseUrl`). The save is safe without that, since an unedited field is
  sent empty and the CLI re-derives — but a filled field reading
  `http://localhost:3080` beside a port of 4000 looks like what is about to be
  written.

**What none of this does is prevent the stale-port case**, and it is worth
being exact because the reverse is easy to assume. `APP_BASE_URL` is in
`OWNED_KEYS`, so it is written on every save, which means after the FIRST save
it is `config.env`-sourced forever, always sent, and changing only the port
leaves a base URL naming a port nothing listens on. The guard there is
`configure`'s port-mismatch warning, not anything here; the console shows the
CLI's stdout verbatim, so that warning is what the user actually reads. What
this side buys is narrower and still worth having: a fresh install does not get
its built-ins frozen into the file.

**First-run configure also installs and starts the service.** "Save and start"
writes config.env and then installs the service, because there is no reason to
configure a server on this machine and not run it. The `install-service` step
remains for the case that means something, a config that already exists with
no service.

**A FRESH machine gets one press, not a form (2026-09-10).** Where no server
exists and one is bundled, `ProbeStep::Setup` shows a single "Set up and
start", and `desktop_setup` runs install → init → service install → start,
each step calling the same extracted body (`install_server_now`, `init_now`,
`service_now`) its own command uses, stopping at the first failure so the
ordinary probe names the remainder. This reverses the rule above it, and the
distinction is what makes both true: the two-click floor protected the PREFILL,
which comes from asking the installed server for its settings — a machine with
no server has nothing to prefill, so the form was four clicks executing a plan
`decide()` had already made. Disclosure moved from the form to the step's hint,
which names every path the press writes to. The press also waits for the
re-probe to say READY before opening the dashboard: `service start` returns
when the manager has spawned the process, not when the port is bound, and
every existing opener of the window (the `ready` button, the tray) opens only
against a server that answers.

**The install offer mirrors a Rust list; the page never sends a command.**
Missing tmux gets `desktop_install_tmux` (brew where it exists, pkexec apt-get
on Linux — never a bare sudo, which has no tty from a GUI and hangs to the
timeout). The decision is pure TypeScript in `ui/src/lib/installers.ts`
(`tmuxInstallPlan`) and is MIRRORED in `control.rs` (`tmux_install_argv`),
because the webview cannot look at the machine and the Rust side is what
decides what may be EXECUTED. The copies are two languages on purpose — the
console's decides what the user SEES, Rust's decides what runs — and they are
pinned to each other by `the_console_install_table_and_the_rust_one_agree`, an
`include_str!` containment test so a token removed on either side fails the
Rust build. `console_platform` normalizes Rust's "macos" to the "darwin" the
console branches on — a wrong spelling there strands every Mac in the
no-button fallback silently, so both sides carry a pin.

Agent CLI installs used to live here too (`desktop_install_agent`,
`AGENT_INSTALLS`, and a JS-side `agentInstallPlan` mirror), run from the
user's own desktop session as the same OS user. They are GONE (spec
2026-09-11 §7), not widened: installing an agent CLI is now the control
plane's job, `POST /api/setup/agents/:id/install`, driven from the setup
assistant's Add an Agent screen (`apps/server/web`) — the host that has the
plugin manifests, so one install arms every launch rather than one desktop
user's own machine. This app's `ready` step offers "Add agents in the
dashboard" instead, which is exactly `desktop_open_main` under a different
label and carries no tmux gate — opening a window needs no pane.

## The console's own panes

The **Logs** section is ONE region with two tabs: the server log, which is true
all the time, and the last command's output, which is brought forward by the
result strip's "Show output" — the moment someone actually asked for it. Two
tabs rather than two stacked panes because a second always-on block pushed the
step actions off the bottom of the old single-column page; the pane fills the
window in its own section now, rather than stopping at a 220px cap.

The tail rides the poll whatever section is on screen, so opening Logs shows a
current pane rather than a tick-old one.

`desktop_logs` is console-only and **takes no argument**. A path parameter
would be an arbitrary-file read reachable from a page, which is the same reason
`desktop_open_path` names a closed enum. The platforms differ in MECHANISM,
not just in path: Linux has no log file at all, so the tail is a `journalctl`
query against the user unit, while macOS has the file the plist names and the
CLI stays the authority on where. It never returns an `Err` — no service yet,
no entries yet, and a file launchd has not created are the ordinary states of a
machine mid-setup, and an error banner for them would train the user to ignore
the pane.

The console **re-probes itself every 5 seconds** (`POLL_MS`), so there is no
Refresh button: the manager's whole subject is state this app does not own, and
a button could only ever save the remainder of one interval while implying the
rest of the panel might be stale. The poll skips while an action is in flight
(it would race that action's own settle) and while the window is hidden, and it
re-probes at once on becoming visible. It is also what drives the tray's
enabled state, since `desktop_probe` is the one place that updates.

## Windows, and getting them in front

**`show` + `unminimize` + `set_focus` does not raise a window on Linux.** A
Wayland compositor refuses an activation request from a surface that is not
already active, so `set_focus` returns `Ok` and nothing moves. That is
invisible with one window and a bug the moment two exist, which is this app's
normal shape: "Manage server" brought the console back UNDERNEATH the
dashboard, so nothing appeared to happen. Every site goes through
`windows::raise`, which adds a momentary always-on-top on Linux, cleared from a
short-lived thread — a compositor that coalesces set-and-clear never raises at
all.

**The console is MINIMIZED when the dashboard appears, never hidden**
(`tuck_console`). A hidden window is reachable only through the tray, and the
Linux tray icon is drawn only where a StatusNotifier host is registered, so
hiding would strand the console on a stock GNOME exactly as `close_to_tray`
would. It is called only where the dashboard becomes VISIBLE — the focus path,
the handshake, the six-second fallback — because the window is created hidden
and tucking at creation would leave nothing on screen at all. The WIZARD is
never tucked and never merely hidden: there is one manage window, so raising
the console or the dashboard CLOSES the wizard, and `desktop_reset` closes the
console only AFTER the wizard exists, so no sequence of these leaves a
zero-window moment for the last-window path to quit on (N2).

**The window-state plugin restores size and position but NOT maximized or
fullscreen**, and a newly created dashboard clears both. A window maximized
once otherwise reopens maximized forever, and a compositor maximizing it on
the user's behalf is enough to latch that. Cleared on creation only, so
maximizing during a session still sticks for that session.

**The tray has no "New Subshell".** It dispatched an action INTO the SPA, so
being enabled needed more than a running server: a server with no users is
sitting on the setup wizard. Nothing this side can see distinguishes those
states — `status --json` carries no user state by design, `ShellReady` fires
from the SPA root on purpose, and there is no HTTP client here to ask
`/api/setup/status`. The tray is a shortcut and never the only route, so the
item is gone rather than gated. That leaves `menu.rs` as the only consumer of
`bridge.rs`, and since the menu bar is macOS-only, `bridge` is gated at the
MODULE — on Linux it is otherwise entirely dead code.

## Native chrome

| Surface | macOS | Linux |
| --- | --- | --- |
| Menu bar | full `NSMenu` | none — a GTK menu bar is per-window chrome, not a system bar |
| Tray | icon + menu, click opens | icon + menu only; **click events are never emitted** |
| Title bar | Overlay, negotiated (below) | ordinary |
| Close to tray | offered, **default on** | offered where a tray is **detected**, default on; clamped off where none answers |

`PredefinedMenuItem::{cut,copy,paste,select_all}` come FIRST in the Edit menu
and are not decoration: without them ⌘C/⌘V do not work at all in a Tauri macOS
webview, because the shortcuts go to the menu bar and nothing claims them. In a
terminal app that is a correctness bug.

Close-to-tray is gated on a **capability probe, not on the platform**
(`crates/desktop-core/src/tray.rs`, shared with `apps/client/desktop`). On
Linux the icon is drawn only where a StatusNotifier **host** is registered on
the session bus — KDE has one, a stock GNOME does not until the AppIndicator
extension is installed — and where none is, the icon is **silently invisible**:
no error, no event, and a window hidden into it is unreachable. So the app
asks, by shelling out to `busctl --user get-property
org.kde.StatusNotifierWatcher /StatusNotifierWatcher
org.kde.StatusNotifierWatcher IsStatusNotifierHostRegistered` (`gdbus` as a
fallback where it happens to exist; never a dependency — webkit2gtk pulls
`libglib2.0-0t64`, not `libglib2.0-bin`). Every non-affirmative outcome — no
bus, no watcher, no tool, a timeout, an unrecognised answer — means "no tray".

Three consequences, all load-bearing:

- `desktop_settings` reports `traySupported` (is the switch live) **and**
  `trayStatus` (`supported` / `not-detected` / `unsupported`), both derived
  from one probe answer. `not-detected` draws the switch **disabled** with the
  reason and a re-check rather than hiding it — naming the extension is
  actionable, an absent control is not.
- `desktop_set_close_to_tray` **refuses** `true` where no tray answered, and
  the preference is clamped on READ as well, because a settings file copied
  from a machine that had one must not strand anyone.
- The window-close handler **re-probes**, and that is the check that actually
  protects the user: a host that has gone away since the setting was made means
  the window closes normally instead of vanishing. The probe is therefore
  deliberately **not memoized** — installing the extension flips the answer
  with the app already running.

It is a false NEGATIVE on the older XEmbed tray (some XFCE/MATE), where
libayatana-appindicator can still fall back to `GtkStatusIcon`; that is why
every string says "none was detected" rather than "there is none". And every
tray action also exists in the window UI or the menu bar regardless — the tray
is a shortcut, never the only route.

### Notifications

The web path is VAPID push through a service worker, and
`apps/server/web/src/lib/notifications.ts` gates on `PushManager` — which neither
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
- **`min_inner_size` is 1024×640, not a preference.** `useIsWide()` is
  `matchMedia("(min-width: 1024px)")`; below it the SPA renders its PHONE
  drawer — the exact chrome this app exists to replace.
- **Never downgrade the installed server.** Boot runs
  `migrator.migrateToLatest()`, which is forward-only. `decide_server` offers a
  newer bundled server and ADOPTS a newer installed one; the reverse is data
  loss, not a choice to present.
- **Icons** come from `brand/` in two steps and never by hand:
  `bun run brand:generate` writes this app's 1024px master to
  `src-tauri/icons/app-icon.png`, then `bun run icons` cuts the `.icns` and the
  sized PNGs from it. The background colour that distinguishes this app from
  `apps/client/desktop` lives in `brand/generate.ts`'s `DESKTOP_APPS` table.
  The master is a ROUNDED one, not `apps/server/web/public/icons/icon-512.png`:
  that is the square web tile, and cutting the `.icns` from it ships a macOS
  icon with hard corners.
- **The tray icon is NOT a template** (`icon_as_template(false)`). macOS draws a
  template from the alpha channel alone and discards every colour, which would
  render this app and the node app as the same filled rounded square — and,
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
- **macOS Login Items attributes a legacy LaunchAgent to the SIGNING
  ORGANIZATION** unless the plist declares the app — so an install without
  `AssociatedBundleIdentifiers` shows as "Disaresta, LLC" with no icon, which
  users read as malware, not as their own server. The plist template
  (`apps/server/api/src/service.ts`) declares `dev.subshell.server`, the one
  string that `DESKTOP_SERVER_BUNDLE_ID` (protocol), the plist label and this
  app's `identifier` all share — pin tests on both sides hold them together,
  because if they drift the association detaches silently and nothing errors.
- **`service status` reports launchd/systemd VERBATIM, and the console passes
  it through.** `launchd: spawn scheduled` is the crash-throttle wait — the
  service IS the one you installed and it IS trying; a manager command that
  fails for any reason other than "Could not find service" (exit 113) answers
  `state: unknown` with the stderr in `detail`, which the console shows in
  red. A manager that would not answer is not the same fact as a stopped
  service, and flattening the two is how the 2026-09-07 crash loop read as
  "stopped" with no explanation.
