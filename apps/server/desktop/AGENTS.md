# Desktop AGENTS.md

`apps/server/desktop` (`@internal/desktop-server`) — **Subshell Server**, a
**Tauri v2** shell that installs, runs and manages a `subshell-server` on this
machine, so a user never has to touch a CLI binary.

**Styling follows `docs/design-system.md`** — six type roles, two weights,
shadcn colour names — and `bun run lint:design` fails on a literal size,
weight or colour outside the token file. Pick a role, never a number.

## Two windows, and why they are two

| Window | Page | Why |
| --- | --- | --- |
| `wizard` | `ui/dist/wizard.html` (Vite output; sources in `ui/src/`), bundled, `tauri://` | **The assistant.** Must render with the server DOWN, and is the only surface allowed to drive the CLI. Owns first run, recovery, update and reset. |
| `main` | the SERVER's own SPA over `http://127.0.0.1:<port>` | `apps/server/web` is hard same-origin. |

**The label is `wizard` and the page is the assistant, and that is deliberate.**
`wizard` is an IDENTIFIER — it keys `WebviewUrl::App("wizard.html")`, the
capability file, every `get_webview_window` lookup and the Vite input — while
the page it carries stopped being only a setup flow. Renaming it would move
four things to rename one, which is the same distinction the root `AGENTS.md`
draws between a directory name and a component id.

**There was a third window until 2026-09-12.** The `console` was a bundled
page of five sections behind a sidebar — Overview, Logs, Addresses,
Application, About — and it was the surface a machine returned to once
`onboarded` said it had been set up. It is gone, with `index.html`,
`ui/src/main.ts`, `ui/src/console/`, `lib/console-nav.ts` and
`capabilities/console.json`. Everything a running server can manage moved into
the SPA, behind four admin routes, so a browser on the LAN and a headless
install get it too; everything that has to work with the server DOWN moved
into the assistant. What is left here is exactly the second half.

**`main` never loads a bundled copy of the SPA.** `src/lib/api.ts` fetches
root-relative with `credentials: "include"`, `src/lib/auth-client.ts` sets no
`baseURL`, `src/lib/use-subshell-ws.ts` builds its WebSocket URL from
`window.location.host`, and there are zero `import.meta.env` reads in the whole
frontend. A `tauri://localhost` page cannot carry the `SameSite=Lax; httpOnly`
session cookie to any of them, and admin routes reject bearer keys by design —
so serving the SPA ourselves would mean an auth rework, not a build change.

## Boot looks before it leaps

`setup()` runs one `boot_probe` and THEN chooses the window, from the fresh
probe rather than the stored flag: `boot_window(&Probe)` answers
`WindowChoice::Main` on a `ready` probe and `WindowChoice::Wizard` on anything
else. So a machine whose server is already running opens the **dashboard** —
including one provisioned entirely from the CLI, on its first app launch,
because the boot probe answers `ready` before the branch runs.

**`onboarded` no longer decides the window.** It decides which FAMILY of
assistant screens a not-ready machine sees: the first-run trio while setup has
never completed, the one recovery screen once it has. `mark_onboarded` is still
the SINGLE writer of the flag (R16) and the only thing that sets it is a probe
whose decision is `ready`; reset is the only thing that moves it back.

Every route home — the tray item, the tray click, the Dock reopen, the
single-instance relaunch, the macOS menu's no-window fallback, and the SPA's
own footer pill — goes through **one function**:

```rust
open_home(app):  probe_now(); if ready → open_main_now() else → open_assistant(None)
```

One function, so no two openers can disagree about which window this machine is
owed. `open_manage_window` and its stored-flag branch are gone with the console.

## The watch thread

The console page ran a 5-second `desktop_probe` poll, and both the tray's
enabled state and the address the app knew hung off it. Deleting that page did
not delete the reason — the manager's whole subject is state this app does not
own — so the poll is `src-tauri/src/watch.rs` now: one thread, `probe_now`
every five seconds for the life of the app.

Its duty is the case the inventory found unhandled: **re-point `main` when the
server's origin moved.** A port changed from the SPA's Service page and a
restart later, the dashboard is a window fetching a dead port, and nothing was
watching for it. `origin_changed(current, probe)` is pure and tested; the
navigate goes through `windows::open_main`'s existing existing-window branch,
which also re-validates the origin as loopback and re-arms the origin pin.

Three rules it keeps:

- **It skips while `control::ACTION_IN_FLIGHT` is held** — an `AtomicBool`
  behind the RAII `ActionGuard` that `desktop_setup`, `desktop_service`,
  `desktop_install_server`, `desktop_install_tmux` and `desktop_reset` take on
  their first line. A probe landing mid-chain reports a half state, and acting
  on it is worse than waiting five seconds. A guard rather than a set/clear
  pair because every one of those commands has early returns in it, and a flag
  left set stops the thread for the rest of the session, silently.
- **It skips entirely when there is no `main` window**, rather than paying CLI
  spawns for an answer nobody is waiting on. A machine sitting on the assistant
  runs that page's own poll.
- **It never raises the assistant.** A server that goes away while the
  dashboard is open shows the SPA's own offline banner; the person reaches
  recovery through the pill, the tray or the Dock. A thread that raised a
  window on its own would take the screen from whatever someone was doing, five
  seconds after a service restart they started themselves.

## The assistant

One fixed frame, one screen at a time. `screensFor(probe, onboarded)` decides
the family and `dots(probe, screen)` where the six dots stand, both in
`ui/src/lib/wizard-state.ts`, pure and tested without a webview.

**First run** is unchanged (spec 2026-09-11): Welcome, Install tmux (shown only
while tmux is missing, and it advances itself the moment the poll sees one),
and Set Up Your Server, whose press replaces the screen with a progress
checklist and then opens the dashboard by itself. `setupRows`/`canSetup`/
`failureLine` hold the checklist, the gate and the failure line. Agents are not
asked about here; the SPA's `/setup` owns that question, because detection
lives in the server.

**Recovery** is ONE screen, where the console was five sections. The title IS
the diagnosis — *No Server Found*, *Your Server Isn't Responding*, *Your Server
Needs Its Configuration*, *Your Server Isn't Installed as a Service*, *Your
Server Is Stopped* — and there is one primary action under it rather than a row
of three the reader has to choose between. `recoveryTitle` and `recoveryAction`
own both, and `lib/recovery-model.ts` owns the subtitle and the facts. Behind a
**Show Details** disclosure: the pre-boot facts (binary and its rung, config
file, service definition, manager state and detail, log location), the server's
own log tail, the last action's verbatim output, and what this app itself is.
A footer link reaches Reset.

**A requested screen is routed off `REQUESTED_SCREENS`, never a literal.**
`screenForRequest` (in `lib/wizard-state.ts`) maps the payload, and the reason
it is a function rather than a ternary at the call site is that the ternary
was wrong three times: `reset` was dropped when it was added, and
`supervision` when IT was added — each time raising the assistant onto a
screen it did not recognise, which then bounced the user back to the dashboard
they had just pressed a button on. Adding a screen means the Rust enum and
that list; there is no third place to forget.

**Update Server**, **Reset** and **How Your Server Runs** are never in `screensFor`'s list. They are
entered by REQUEST — a `desktop-screen` event (a LIVE window) or the `desktop_pending_screen` pull (a window still coming up) carrying a member of the closed
`reset::Screen` enum (`home` | `reset` | `update` | `supervision`) — which is what lets either
appear over a first run as readily as over a recovery without either family
naming them. A requested screen outranks the ready handoff in `render()`, or
the SPA's Update deep link would bounce the window straight back to the
dashboard it was asked to leave.

**`dots` has no position for the requested screens.** `indexOf` answers -1 for
recovery, update, reset and supervision, and the renderer hides the row on a negative
`current`. That falls out of one list rather than a branch: a screen is either
on the journey or it is not.

**Show Details keeps its openness in PAGE state**, not the element's.
`#content` is rebuilt on every render and the poll renders every 1500 ms, so a
`<details>` whose state lived only in the DOM collapsed under the reader twice
a second. The failure screen had exactly that defect from the day it shipped.

The window is **1024x720, fixed and not resizable**, and `open_main` takes its
position and size when the dashboard is created, so the swap reads as one
window changing screen; the SPA continues the dot row (six dots, three filled)
when it sees the desktop UA marker.


## Who runs the server

Two answers, and the operator picks at setup (§ "The assistant") or later from
**How Your Server Runs** — spec 2026-09-12 server-supervision.

| | a service | this app |
|---|---|---|
| what runs it | launchd agent / systemd user unit | `supervisor.rs`, as a child process |
| survives the app closing | yes | no — "runs with this app" means it |
| comes back at login | when armed (`service enable`) | only if the app does |
| SPA Restart server | works | works, and takes ~5s |

**The DISK outranks the stored preference**, always in that direction
(`effective_supervision`). Someone can install a service from a terminal on a
machine this app last set to app mode; if the preference won, the app would
believe it owned a process it never spawned — and `RunEvent::Exit` would stop
it on quit, taking down a server the operator had just arranged to be
permanent. A manager that will not ANSWER is not evidence of absence, so the
preference stands there rather than flipping a machine's mode on a `launchctl`
hiccup. The probe writes the correction back, single-writer, the way
`mark_onboarded` does.

**`decide()` gains exactly one branch**, and without it app mode has no steady
state: `!installed` would answer `InstallService` forever — the assistant
nagging to install the very thing the operator declined, `mark_onboarded`
never firing, boot never opening the dashboard. In app mode the PORT is the
whole question.

**The supervisor answers a service manager's questions the same way a manager
does**, because that is what makes the rest of the system work unchanged:

- **Respawn on any exit, after five seconds** — `Restart=always` +
  `RestartSec=5` + `StartLimitIntervalSec=0`, the systemd unit's own numbers.
  No start limit, so an EADDRINUSE loop stays a loop the probe reports rather
  than parking in `failed`. A restart someone ASKED for skips that wait; five
  seconds of nothing is right for a crash and wrong for a button.
- **SIGTERM to the MAIN PID, never the process group.** Each local subshell's
  tmux server is a child of the server, so a group signal takes every live
  pane with it — `KillMode=process` / `AbandonProcessGroup=true` are the
  managers' spellings of the same promise. Sent through one bounded
  `kill(1)` spawn rather than a `libc` dependency, the same precedent
  `hostname` set. Ten seconds, then SIGKILL.
- **It names itself to the server** (`SUBSHELL_SUPERVISOR`,
  `SUBSHELL_SUPERVISOR_PID`, `SUBSHELL_SUPERVISOR_LOG`), which the server
  believes only when the pid is its own parent. That is what makes
  `GET /api/admin/server` report `manager: "app"`, `supervised: true` and
  `paneSafety: "keeps"` — so the SPA's Restart button works with no change to
  `performRestart`.

It lives in this app rather than `crates/desktop-core` by the crate's own
rule: Subshell Client's node agent has its own service and no equivalent mode,
so an abstraction here would be one real consumer and one guess.

**Console output** goes to one file, truncated per spawn — the last run's
output is the thing worth reading after a crash, and it is bounded by
construction. macOS reuses `~/Library/Logs/subshell-server.log`, the path the
plist already names, so `desktop_logs`' fallback finds it with no new rung and
someone switching modes keeps reading one file; Linux takes
`$XDG_STATE_HOME/subshell-server/console.log`, because the unit's journal has
no part in an app-run server.

**Boot starts it and waits** (`BOOT_START_GRACE`, 5s): `spawn` returns when
the process exists, and the window choice needs the PORT. Slower than that
lands on recovery, whose Start is idempotent and whose screen names the last
exit.

**One load-bearing macOS fact is UNMEASURED, and must be confirmed once.**
The whole "starts at login" mechanism rests on launchd auto-loading only
`~/Library/LaunchAgents` — so a plist kept in the config home runs when
something bootstraps it and not at login. That a `KeepAlive=true` job ignores
`RunAtLoad=false` WAS measured (macOS 26.6.2, 2026-09-12); the login half was
not, because measuring it means logging the operator out. On the first machine
to run this: `subshell-server service install --no-autostart`, log out, log
in, and confirm `service status` reports not running and
`launchctl print gui/$(id -u)/dev.subshell.server` answers "Could not find
service". **If it IS loaded, stop and report — the design needs a new
mechanism**, not a patch.

To check the rest by hand — none of it has automated coverage:

1. Launch with box 1 unchecked, start a subshell, quit the app, and confirm
   the pane's tmux server survives (`tmux -L subshell-<id> ls`) while the
   server is gone. This is the pane-safety promise, and no test can prove it.
2. Reset with close-to-tray ON: the whole app relaunches into first run, with
   no dashboard recoverable from the tray.
3. The door both ways from the dashboard's Service page, and the login switch
   on a machine that really has a service installed.

## Resetting the machine

Entry is the dashboard's Settings danger card (admin + desktop marker,
`apps/server/web`); confirmation and execution are the ASSISTANT's. The remote
page may name a SCREEN, never a path or a command:
`desktop_open_assistant({ screen: "reset" })` parses a closed enum, and
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
destroy `main`, send THIS page back to `home`, and **restart the app**, which
its own re-probe (now `onboarded: false`) agrees with. With one bundled page the zero-window hazard
(N2) reduces to a single rule: **never close the assistant from inside the
chain.** It is the window the command is running in, and closing it once
`main` is already gone runs the last-window path and quits the app mid-reset.

**The chain is on the meter while it runs (spec 2026-09-13).** A legitimate
reset spends tens of seconds in compiled-CLI spawns and one kill per pane
socket, and a dead button lettered "Resetting…" reads identically to a hang —
reported as one. `ResetStep` (`stop | panes | service | files`) is the Rust
enum behind `desktop-reset-step` frames of `{step, state}`, the page mirrors
it in `lib/reset.ts` beside its own first row (`plan`, the arming round trip),
and the containment is pinned both ways by
`reset_steps_round_trip_and_mirror_the_page`. The states live in the view,
not the DOM — same reason `Show Details` keeps its openness — because
`renderSteps` rebuilds inside a render that runs on the poll's clock. An
unknown wire word drops (`knownStep`): a page newer than its binary is
`tauri dev` HMR's normal condition.

**The manager's "stopped" is a claim the chain now verifies — and the claim
itself was the CLI bug.** Measured 2026-09-13: a service-mode stop returned
success while the process kept running for 90 more seconds, and the deletes
ran anyway — the server's own log filled with `SQLITE_IOERR_VNODE` as its
database went out from under it. Root cause in `apps/server/api/service.ts`:
`bootout` is ASYNCHRONOUS — a fact `domainBusy()` has documented since
2026-09-12 — but only the install path ever acted on it, and stop answered
"subshell-server stopped." on bootout's exit-0 alone. CLI stop now polls the
domain until `print` gives the same "no such job" answer `queryService` calls
stopped (30 s budget, `STOP_WAIT_ATTEMPTS`) and fails honestly if the job
never leaves; the tests pin the poll, and two old tests whose `at(-1)`
assertion ended at bootout were updated because they had pinned the lie. The
desktop chain keeps its OWN dial check (`dial_target`, 10 s, after the stop)
because it is the manager-independent half: a server nobody's manager owns —
the hand-run process, a stray on the port — is visible only on the port.
`listen.port` joined the all-or-nothing plan block (R17 applies exactly as to
a path: the page's `refusal` refuses without it, so screen and plan cannot
disagree about "armable"). The app-mode branch needed no second opinion —
`sup.stop` blocks on the pid it signalled and already answers false for a
stop that gave up.

**The tmux sweep skips only when the DIRECTORY agrees there is nothing to
do.** Measured 2026-09-13 and NOT fully explained: a reset chain completed
steps 1–7 with 69 stale `subshell-*` sockets on disk and tmux installed — step
3 skipped silently. The first suspect, `which("tmux")` answering None, was
disproven afterwards by reading `build_path`: it appends the FLOOR (which
includes `/opt/homebrew/bin`) UNCONDITIONALLY, so no probe failure can hide an
installed tmux. The surviving suspect is the directory — an inherited
`TMUX_TMPDIR` pointing the read elsewhere — unconfirmable after the fact
because the launching terminal's environment died with the dev session. The
fix therefore targets silence, not the guess: empty directory skips as
before; sockets present means tmux ran here once, so the sweep goes through
each spawn's own login PATH regardless, a spawn failure keeps ending the chain
as "a pane may have survived", and the skip's log line NAMES the directory it
looked in — if the surviving suspect fires again, it identifies itself.

**A dev build does not restart after a reset.** `app.restart()` re-execs the
binary OUT of the `tauri dev` process tree — the CLI sees its child exit and
quits, taking the Vite server (`beforeDevCommand`) with it, and a debug
binary loads `devUrl`, so the relaunched window renders white against a dead
:5178. Reported 2026-09-13 as "the FTE screen is white" after exactly that.
Under `cfg!(debug_assertions)` (runtime, not `#[cfg]`, so `schedule_restart`
never goes dead-code) the success arm takes the window-move fallback that
already existed for "a restart that does not happen": the live page
re-probes, sees `onboarded: false`, and draws first run in place. Release
ships embedded assets and restarts as designed — the white window was never
a shipped-app bug, and nothing on the reset path branches on build kind
except this gate.
Pane closing goes through tmux's OWN directory rule —
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
anything mutated. The screen renders the half-run's log where the human still
is, styled as a failure, with the button re-labelled Retry.

**The reset ends by restarting the app, and three details hold that up.**
Reaching first run by RESTARTING is by construction; reaching it by closing a
window and telling the page to go back was by inference, against a machine
still settling — a draining port answers `ready` for a moment longer, and the
ready path re-opens the dashboard and closes the assistant. Reported on
2026-09-12 as "the reset window closed and the dashboard stayed".

- **`destroy()`, not `close()`, for `main`.** `close()` raises
  `CloseRequested`, which this app answers on `main` by preventing it and
  HIDING the window while close-to-tray is on — the default. A hidden
  dashboard is one tray click from being back on screen pointed at a port that
  no longer answers, which is the other half of that report.
- **`restart()` on the MAIN THREAD.** Off it, Tauri routes through
  `RunEvent::ExitRequested`, which this app prevents while close-to-tray is on
  and a `main` window exists — and then parks the calling thread in
  `loop { sleep(Duration::MAX) }` forever (tauri 2.11.5 `app.rs`). A
  "simplification" to a bare `app.restart()` off-thread hangs silently.
- **The binary is resolved before the restart is attempted.** `restart()` is
  `-> !` and `exit(0)`s when it cannot find the current executable
  (`process.rs`) — a bundle reached through a symlink is enough — so the app
  would vanish with nothing respawned and nothing said. Resolving
  `current_binary` first turns that into the assistant staying on screen.

To check it by hand — it has no automated coverage — reset with close-to-tray
ON and confirm the whole app relaunches into first run, with no dashboard
recoverable from the tray.

**The Reset screen replaces the frame rather than filling it**: `#screen` and
`#bar` are hidden while it is up. The reason survived the console's sidebar
going away — this screen's premise is that it is the only thing happening, so
a Back button in a live bottom bar would be a way out from under a chain that
has none.

**Its label names what is reset.** `RESET_LABEL` is one string, used by the
recovery footer and carried verbatim by the screen's own title, and it is
`Reset this server` here and `Reset this client` in the other app (operator's call, 2026-09-12). It was
`Reset ${here()}…`, which rendered "Reset this Mac…" and was wrong twice over:
it read as TRUNCATED, because "Mac" is a prefix of "Machine", the Linux
sibling really is "this machine", and the label ended there under an ellipsis
— it was reported as a layout bug — and it OVERCLAIMED, because "Reset this
Mac" is a sentence that means erase the computer. A destructive label that is
frightening about the wrong thing is worse than one that is frightening: it
teaches people that these labels do not mean what they say. One label now
covers two acts of very different severity (this one deletes the database
holding every user, every API key and the node signing keypair; Subshell
Client's deletes a node's config and key), and what makes that survivable is
that the label is a DOOR rather than the consent — the screen behind it
enumerates the five paths and demands the hostname typed, and the two apps'
windows are titled differently.

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

## macOS permissions (spec 2026-09-14)

A first run on a Mac meets four system prompts or banners, and only ONE is the
app's own: Notifications. Files-and-Folders is attributed to whichever process
lists the folder (`subshell-server` under launchd, this app under "runs with
this app"), Photos is raised by the image picker's own panel, and Background
Items is a banner, not a permission. So the `permissions` screen — macOS only,
between Install tmux and Set Up — REQUESTS Notifications and EXPLAINS the
other three, and never blocks Continue. It is also a REQUESTED screen (the one
in both lists): the dashboard raises it as the fix for every missing-permission
notice, and it tells a requested visit from a first-run one by whether
`screensFor` already holds it.

**Tauri's notification plugin cannot see any of this.** Its desktop
`permission_state()` and `request_permission()` are stubs that answer
`Granted` (2.4.0, measured), so the truth comes from `UNUserNotificationCenter`
and `PHPhotoLibrary` directly, in `crates/desktop-core/src/permissions.rs` —
shared, because Subshell Client will want the notifications half the day it
notifies. Two facts about that module are load-bearing:

- **The bundle guard runs before every call, and checks BOTH halves.** The UN
  API aborts a process that is not an `.app` bundle — no error, no stack, the
  window just never paints — and `tauri dev` runs the bare binary. A bundle
  identifier alone is not proof: `tauri-build` embeds an `Info.plist` into the
  dev binary through a linker section, so `bundleIdentifier` answers there too.
  The bundle PATH ending in `.app` is what a linker section cannot fake. Dev
  therefore answers `unavailable` by design, the page says "Permissions can only
  be requested from the installed app", and the real prompt is testable only in
  a built app. `cargo test` in desktop-core is itself not a bundle, which is why
  its test that every function answers `Unavailable` there is the crash guard
  under test.
- **Both states ride on the probe** (`notificationPermission`,
  `photosPermission`), so the screen re-reads them on the poll it already runs.
  The dashboard cannot read the probe, so it has `desktop_permissions` — the
  sixth `main` command, read-only, no argument, argued in `docs/security.md`
  and in `capabilities/main.json`'s own comment. Requesting and opening a
  System Settings pane are `wizard`-only; `desktop_open_system_settings` takes
  a closed `SettingsPane`, never a URL, the `WebTarget` shape.

`src-tauri/Info.plist` carries the four usage descriptions; they are the
sentence a prompt attributed to THIS APP shows, and a prompt attributed to
`subshell-server` under launchd shows none, which is what the `files` row's
attribution sentence is for. The row model is pure
(`ui/src/lib/permissions-model.ts`): every `Permission` value to a glyph state,
a suffix and an action, and which pane each row opens.

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
otherwise launch a Tauri window for everyone. This app's Vite port is
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
├── lib.rs         # plugins, command registration, setup (boot PROBEs, opens `main` or `wizard`, spawns the watch)
├── windows.rs     # the two windows, the 360x240 floor, the UA marker with its `b=` group
├── watch.rs       # the 5s poll: the tray's state, and re-pointing `main` when the origin moves
├── control.rs     # the tauri commands — argument-poor wrappers over the CLI; open_home; ACTION_IN_FLIGHT
├── reset.rs       # the reset screen's Rust side: the closed Screen enum, the stashed plan, the two guards, the chain
├── supervisor.rs  # running the server as THIS APP'S child: the respawn loop, the stop that blocks, the signal discipline
├── server_bin.rs  # the ladder, ExecStart parsing, bundled-vs-installed policy, SERVER_SIDECAR
├── bridge.rs      # the DesktopAction enum and the eval dispatch
├── menu.rs        # the macOS menu bar
└── tray.rs        # the tray icon and its menu, including the close-to-tray check item
```

The assistant is TypeScript on Vite with Tailwind (since 2026-09-10; the
plain-JS original had no build step, which the section on the CSP explains).
**One HTML input, one build, one bundle** — the second input went with the
console, and `vite.config.ts` names the remaining one explicitly rather than
leaning on Vite's `index.html` default, because a default that found nothing
would ship a bundle in which `WebviewUrl::App` resolves to a 404 with no build
error anywhere. `tauri-config.test.ts` pins that there is exactly one, and that
no orphan `index.html` sits beside it.


## What the page is made of

```
ui/
├── wizard.html         # the ONE bundled page; every id the assistant binds is in it
├── src/
│   ├── wizard.ts       # the ENTRY: state, the screens, render(), the poll, the screen listener
│   ├── assistant/      # the screen modules, each taking an AssistantHost
│   │   ├── host.ts     #   the contract, plus el() and errText()
│   │   ├── logs.ts     #   renderTail() and renderOutput(), for the Show Details panes
│   │   ├── tmux-warning.ts  # the amber gate explanation — a FACTORY
│   │   └── reset-view.ts    # the Reset screen, which replaces the frame
│   ├── styles.css      # @theme tokens + component classes; Tailwind in markup
│   ├── lib/
│   │   ├── ipc.ts            # one typed function per `desktop_*` command this page invokes
│   │   ├── config-form.ts    # the pure form contract (see below)
│   │   ├── installers.ts     # the pure install plans
│   │   ├── wizard-state.ts   # screensFor, dots, recoveryTitle/Action, RESET_LABEL, the checklist
│   │   ├── recovery-model.ts # the recovery screen's subtitle, facts and pane risk
│   │   └── reset.ts          # the reset screen's pure decisions: rows, refusal, arming
│   └── __tests__/      # pure pins: config-form, installers, wizard-state, recovery-model, reset, ipc-acl, tauri-config
└── dist/               # `frontendDist` — built, gitignored, never hand-edited
```

The split rule the plain-JS version established still decides WHERE logic
lives: anything with a contract rather than a rendering goes in `lib/`, where
it is testable without a webview. Everything under `ui/src/assistant/` holds
only the DOM.

Three things about that arrangement are load-bearing:

- **No module under `assistant/` imports `wizard.ts`.** They take an
  `AssistantHost` (`probe`, `busy`, `setBusy`, `render`, `refresh`, `fail`,
  `close`) instead. A cycle back to the entry is not a type error and not a
  lint error — it is a temporal dead zone at module evaluation, i.e. a BLANK
  window on the machine someone is repairing. The console's `ConsoleHost` had
  the same rule; what is missing here is `goTo`, because there is no sidebar
  and no sections, so a module that could navigate would be navigating a
  structure that does not exist. `close()` replaces it: leave a requested
  screen for whatever the probe implies.
- **`tmux-warning.ts` is a factory**, and the reason survived the console. It
  needed one per gated surface because two sections rendered at once; here the
  element is re-appended by every render, and one created per render would
  throw away a half-finished Copy.
- **`lib/recovery-model.ts` exists so the recovery screen's WORDS are
  testable.** Its subtitle and its facts were the console's step table and
  Details list — DOM, in a render that needs a webview, which is why neither
  was ever covered. They are data now, and `recovery-model.test.ts` covers the
  rows that only appear when something is wrong: an unresolved MCP entrypoint,
  a port answering while the service is not running, a teardown that kills
  live panes, a manager that would not answer.

**About is inside Show Details, and it owns no strings.** `desktop_about`
supplies this app's name, its version, the licence summary and the copyright
line from `crates/desktop-core/src/legal.rs`, which `scripts/license-fields.ts`
holds equal to the TypeScript copy and to the root `LICENSE`; the three links
go out through `desktop_open_web`, a CLOSED enum, so the addresses travel to
the page for display and never travel back. A third copy in `ui/src` would be
the one copy that detector cannot see, and a drifted copyright line is
invisible — nobody re-reads an About box.

**That is also why those two commands still have callers.** The SPA grew an
About dialog for everyone (spec 2026-09-12), so the obvious move was to delete
this one — but on a machine whose server is DOWN the SPA is unreachable, and
the assistant is then the only surface that can say what this app is. Which is
precisely the machine this page exists for.

## The log, and the last action's words

The console's Logs section was one region with two tabs, a caption and a
selection that had to survive navigation. None of that survives it: the
assistant shows one screen at a time, and both panes live inside the recovery
screen's Show Details, one under the other. A tab strip over two panes inside
a disclosure inside a 560px column is chrome for its own sake.

What DID survive is the behaviour that was load-bearing. The tail **sticks to
the bottom only when it is already there** — re-tailing while someone has
scrolled up to read would yank the view out from under them, and this runs on
the poll. A note (no entries yet, no service installed) renders as the pane's
own muted text rather than as an error, because during setup it is the
ordinary answer and an error banner would train the reader to ignore the pane.
The last action's output is styled `output-bad` on `ok: false`, the same
treatment the reset screen's half-run log gets, so two surfaces never phrase
one outcome differently.

`desktop_logs` is assistant-only and **takes no argument**. A path parameter
would be an arbitrary-file read reachable from a page, which is the same reason
`desktop_open_path` names a closed enum. It reads the SERVER's own capped
JSON-lines file first, on every platform — `status --json`'s
`paths.serverLog`, the same file the SPA's Service page shows, so the two
surfaces cannot describe different logs — and falls back to the service
manager's log only when that field is absent (a server older than it) or the
file has nothing in it yet. The fallback platforms differ in MECHANISM, not
just in path: Linux has no file at all, so it is a `journalctl` query against
the user unit, while macOS has the file the plist names and the CLI stays the
authority on where. It never returns an `Err` — no service yet, no entries
yet, and a file launchd has not created are the ordinary states of a machine
mid-setup.

**The tail is pulled only while the disclosure is open.** A CLI spawn every
1500 ms for a collapsed `<details>` is the cost with none of the benefit,
which is the rule the console's poll kept about its own hidden window.

The page **re-probes every 1500 ms** (`POLL_MS`), so there is no Refresh
button: the manager's whole subject is state this app does not own, and a
button could only ever save the remainder of one interval while implying the
rest of the screen might be stale. The poll skips while an action is in
flight, while the window is hidden, and while a hand is in an input — the
address form and the reset screen's confirmation box are both places a redraw
would throw away what was typed.


## The IPC boundary

`src-tauri/permissions/desktop.toml` is the app's own ACL manifest, and its
**existence** is the boundary — not just its contents. Tauri gates an app
command when `plugin_command.is_some() || has_app_acl_manifest || !is_local`
(tauri 2.11.5, `webview/mod.rs`). Without that file every app command is
ungated for every LOCAL window, so any window added later would silently
inherit the ability to drive the CLI.

With it, the split is enforced, and the split is window KIND:

| Window | Gets |
| --- | --- |
| `wizard` | the sixteen its page invokes — probe, setup, install tmux, install server, set the binary, set supervision, every service verb, logs, open path, arm reset, pending screen, reset, open main, open tmux docs, about, open web — plus `dialog:allow-open` and `opener:allow-reveal-item-in-dir` |
| `main` | `desktop_open_assistant`, `desktop_shell_ready`, `desktop_notify`, `desktop_open_in_browser`, window dragging — and `desktop_set_supervision` (below) — over loopback only |

`main`'s first four are chosen for what they cannot do: raise a window, drop
this app's own title bar, display one notification with a fixed shape, and
open a page of THIS server in the system browser.
`desktop_set_supervision`, the fifth, is granted by operator decision
(2026-09-12) so the dashboard's supervision card can confirm in its own dialog
rather than raising the assistant; `docs/security.md` carries the accounting,
and `ipc-acl.test.ts` pins `main` at exactly these five so a sixth is loud.

`desktop_open_in_browser` (2026-09-14) is of the harmless kind and its
harmlessness is in the ARGUMENT: it takes a PATH — no scheme, no
protocol-relative `//host`, no backslash, no whitespace or control characters,
all refused by `crates/desktop-core`'s shared `browser` module — and joins it
onto this window's own loopback origin, so the page names the route and Rust
names the host. Its signature is pinned as well as its name, because an
exception is only as narrow as its arguments. A webview has no address bar and
no second tab, which is the whole reason it exists; the tray's and the View
menu's "Open in Browser" reach the same act from Rust and need no grant at all.
Two things a person will notice and that this does not try to fix: the browser
carries no session cookie from the webview, so they sign in again; and the
origin opened is LOOPBACK, where a passkey works only if `APP_BASE_URL` is
loopback.
Nothing else that touches the CLI, the config, the service or the filesystem
is reachable from a page the server serves. `desktop_open_assistant` takes an OPTIONAL
`screen` argument, and the SPA sends it from exactly three places: the
Settings danger card (`{ screen: "reset" }`), the Service page's Update card
(`{ screen: "update" }`) and the sidebar pill (no argument). The supervision
card sends none: it confirms in its own dialog and calls
`desktop_set_supervision` itself. It names a SCREEN
and never a command — raising `update` performs one read-only probe, arming
`reset` performs one `status --json` the watch already runs on its own timer,
and every verb behind either needs a press inside the bundled page.

**`dialog:allow-ask` is deliberately NOT granted.** It was the console's, for
its update and restart confirmations. Both of those are screens now, with
their consequences written on the screen rather than inside a system sheet, so
nothing calls `ask` — and a granted permission with no caller is the erosion
these pins exist to catch, read from the other end.

**HMR reaches the assistant and NOT the dashboard, and that is the shape of
the app rather than a broken config.** `tauri dev` starts the bundled page's
own Vite server (`devUrl`, `beforeDevCommand`), so edits under `ui/` hot-reload.
The dashboard window loads the RUNNING SERVER's origin, and that server is the
installed `subshell-server` binary serving the SPA embedded in it at build
time — so an edit in `apps/server/web` reaches that window not slowly but not
at all, until the SPA is rebuilt, embedded, installed and restarted.

**`bun run dev:desktop-server` does this for you.** The launcher probes
`http://localhost:5174` and, when the SPA's own Vite server answers, points the
dashboard window THERE — it proxies `/api` and `/ws` to the real server, and
it is the only way that window hot-reloads. It says which of the two it chose
on startup, so the absence of hot reload is never a silent mystery.

Detected rather than assumed, and never started: a window aimed at a dead port
is worse than the default, and starting a second Vite would fight the one
`bun run dev` may already own. So the order is `bun run dev` in
`apps/server/web` first, then the app. `SUBSHELL_DESKTOP_SPA_URL` still wins
when set explicitly, which is what makes a non-default port possible.
Three things make it safe rather than a hole: it is read only under
`debug_assertions`, so a release build ignores the variable before looking at
it; the value must be a loopback `http://` origin, which `open_main` re-checks
independently; and it is applied inside `Probe::origin` rather than at the
`open_main` call sites, because `watch.rs` compares the window's URL against
that same answer and would otherwise navigate back to the server's port on the
next tick. The substitution is printed on stderr every time.

Two consequences to expect, both correct: the Service page reports the
SERVER's port (3080), not the window's (5174), because it describes the server
— `DevProxyNotice` says so on that page and on Status, in dev builds only —
and `resumeElsewhere` fires permanently, because the base URL's origin really
is not the page's. Editing the Port field under the override moves the server
out from under Vite's fixed proxy target until Vite restarts.

**`withGlobalTauri` is load-bearing for `main`, not for the bundled page.**
The SPA's desktop bridge (`apps/server/web/src/lib/desktop.ts`) reads
`window.__TAURI__` — it imports nothing — and it takes its desktop branch
because `windows.rs` marks `main`'s user agent `SubshellDesktop/…`. Turning
the global off while the marker ships kills the title-bar handshake, the
server pill, native notifications and window dragging, and kills them
SILENTLY: the bridge never throws and the ACL stays green. Subshell Client
ships `true` as well since 2026-09-14 — its plane window carries a
`SubshellClient/…` marker and one command now, and the same pair rule applies
there. The pair, not either half, is what `tauri-config.test.ts` pins in both
apps.

**That marker carries the bundled server's version.**
`SubshellDesktop/0.2.0 (macos; p=1; b=0.3.0)` — `b=` is what
`bundled_version()` reports, and only the app knows it, so it is the one way
the SPA's Service page can offer an update. The group is optional, so a build
that ships no server, Subshell Client (whose `SubshellClient/…` marker never
carries one — it bundles a node agent) and every older shell
stay valid against the same regex; `DESKTOP_PROTOCOL` is unchanged by it.
`user_agent_for` is the pure body, pinned by test.

**The three-way contract is pinned, because nothing else catches it.** A
command name lives in the calling page module, in `permissions/desktop.toml`
and in a capability file; missing from any one is a runtime permission
refusal, not a compile error. `ui/src/__tests__/ipc-acl.test.ts` asserts that
the commands invoked by the assistant page — `ui/src/wizard.ts` plus every
module under `ui/src/assistant/` — are EXACTLY the set `wizard.json` grants,
that `ipc.ts` hides nothing extra, that no capability names an undefined
permission, that no defined permission goes ungranted, and that `main` still
holds exactly its five commands plus window dragging — by name, by count, by
SCOPE (loopback both spellings, `local: false`, one window id), and for the two
that take arguments, by Rust signature.

**The count is a number worth a test**, because "a few harmless ones" is how a
boundary erodes. Three more pins arrived with the console's deletion: that
`capabilities/` contains exactly `main.json` and `wizard.json` (a third file
is a third window, and a window added without a deliberate grant list is what
the manifest exists to prevent), that no file under `ui/src` names any of the
five commands the console took with it (`desktop_open_console`,
`desktop_init`, `desktop_settings`, `desktop_set_close_to_tray`,
`desktop_open_control_plane`) — a leftover name is an invoke that rejects at
runtime, indistinguishable from a permission it was never granted — and that
nothing reaches Tauri outside `lib/ipc.ts`.

**`ipc.ts` does not wrap `main`'s three.** `desktop_open_assistant`,
`desktop_shell_ready` and `desktop_notify` belong to the SPA, which reaches
them through its own bridge. A wrapper here for a command this page never
calls would break the exact-set pin by describing a surface the assistant does
not have.

**The opener surface is the same rule with paths.** `desktop_open_path` takes
a CLOSED enum (`config-env | server-dir | service-definition | logs`), never a
path — the page names an intent and the Rust side re-reads the path from its
own fresh probe, so a row can only ever reveal the fact it is showing (the
client's `node_open_path` for the same reason). `logs` is answered entirely by
the CLI's `service status --json → logPath`: a null is the journal-hint case,
an absent field is an old server, and this side never re-derives a platform
path. `desktop_open_web` is the same shape for the About block's three links
(`website | license | company`). `desktop_open_control_plane` is GONE — the
base URL is the SPA's Service page to show and to copy now, and no URL crossed
the IPC boundary from the page in either design. The
`opener:allow-reveal-item-in-dir` grant in `capabilities/wizard.json` covers
the plugin side; the app commands are gated by their own permission entries
here.

`main`'s page is served by the subshell-server this app manages, so it is
treated as remote content. `capabilities/main.json` carries `remote.urls`
scoped to loopback, and `open_main` additionally refuses a non-loopback origin
and pins `on_navigation` to the origin it was opened with — three independent
gates, because the window holds privileged globals.

The bundled page has a real CSP (`script-src 'self'`), which is why its logic is a
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
breaks the assistant with no error anywhere.

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
`configure`'s port-mismatch warning, not anything here; the page shows the
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
page's decides what the user SEES, Rust's decides what runs — and they are
pinned to each other by `the_console_install_table_and_the_rust_one_agree` (a
test whose name outlived the window it was written for), an
`include_str!` containment test so a token removed on either side fails the
Rust build. `console_platform` normalizes Rust's "macos" to the "darwin" the
page branches on — a wrong spelling there strands every Mac in the
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

## Windows, and getting them in front

**`show` + `unminimize` + `set_focus` does not raise a window on Linux.** A
Wayland compositor refuses an activation request from a surface that is not
already active, so `set_focus` returns `Ok` and nothing moves. That is
invisible with one window and a bug the moment two exist, which is this app's
normal shape: the pill brought the bundled window back UNDERNEATH the
dashboard, so nothing appeared to happen. Every site goes through
`windows::raise`, which adds a momentary always-on-top on Linux, cleared from a
short-lived thread — a compositor that coalesces set-and-clear never raises at
all.

**Nothing tucks anything any more.** `tuck_console` minimized the console when
the dashboard appeared, because there was one manage window and raising either
retired the other. With two windows the assistant and the dashboard are both
legitimately open at once — a recovery screen beside a dashboard showing its
own offline banner is a real state — so `open_assistant` closes nothing, and
`open_main_now` still closes the assistant only because the assistant's own
job ends at the dashboard, by either door.

**The window-state plugin restores size and position for `main`, and tracks
the assistant NOT AT ALL** (`DENYLIST`). Measured on 2026-09-12: a state file
left by an older session restored 757x706 over the assistant's fixed 1024x720
frame, and it came up at that size on a machine whose server was merely
stopped. Latent until the assistant started opening on every not-ready boot
rather than on first run alone — a first-run machine has no saved state by
definition.

**That trap is worth stating for the next fixed-size window someone adds.** A
restored size is wrong TWICE for a frame like this: the layout is drawn to
that arithmetic, and `open_main` INHERITS the assistant's position and size so
the dashboard appears in its place — which would carry a stale size straight
into a window sized for a screen that is no longer there. Denylisting the
label is the fix rather than
dropping `StateFlags::SIZE`, because the dashboard's size IS worth
remembering and the assistant's is not a user choice at all: it is
non-resizable and centred.

**VISIBLE, MAXIMIZED and FULLSCREEN are never restored either**, and a newly
created dashboard clears the last two. `main` is created hidden on purpose and
shown by the title-bar handshake, so restoring visibility would show it
decorated before the page can ask for the overlay. A window maximized once
otherwise reopens maximized forever, and a compositor maximizing it on the
user's behalf is enough to latch that. Cleared on creation only, so maximizing
during a session still sticks for that session.

**The tray has no "New Subshell".** It dispatched an action INTO the SPA, so
being enabled needed more than a running server: a server with no users is
sitting on the setup wizard. Nothing this side can see distinguishes those
states — `status --json` carries no user state by design, `ShellReady` fires
from the SPA root on purpose, and there is no HTTP client here to ask
`/api/setup/status`. The tray is a shortcut and never the only route, so the
item is gone rather than gated. That leaves `menu.rs` as the only consumer of
`bridge.rs`, and since the menu bar is macOS-only, `bridge` is gated at the
MODULE — on Linux it is otherwise entirely dead code.

## Text size is Rust's, not the page's

⌘+ / ⌘− / ⌘0 (View, on macOS) and the tray's **Text Size** submenu walk a fixed
ladder — `0.8 · 0.9 · 1.0 · 1.1 · 1.25 · 1.5 · 1.75 · 2.0` — stored as `zoom` in
this app's own `settings.json` and applied with `WebviewWindow::set_zoom`. The
ladder, the clamp and the frame arithmetic are `desktop-core`'s `zoom` module;
`src/zoom.rs` here is the level, the menu ids and the apply.

**Tauri's own `zoom_hotkeys_enabled` was rejected, and the reason is the trust
boundary.** On macOS and Linux it injects a page script that invokes
`plugin:webview|set_webview_zoom`, so it works only on a window granted that
command. It also keeps its level in a page-local variable, which a
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

- **The preference lives in the TRAY**, as a `CheckMenuItem` beside Open
  Subshell Server. It was a switch on the console's Application section, read
  through `desktop_settings` and written through `desktop_set_close_to_tray`;
  moving it RETIRED both commands rather than relocating them, which is the
  point — a preference about the tray belongs in the tray, and the page that
  held it is gone. The item is seeded from the CLAMPED value
  (`close_to_tray_now`), because a check mark promising a behaviour the app
  will not honour is a check mark that lies.
- **muda flips the item before the event fires** (measured against muda 0.19.3
  on both the macOS and the GTK backends), so `set_close_to_tray` READS
  `is_checked()` rather than toggling a stored copy — two places deciding what
  "checked" means is how a menu ends up disagreeing with itself. Turning it ON
  is refused where no StatusNotifier host answers, with the item put straight
  back; turning it OFF is always allowed, because that direction can only make
  the window easier to reach.
- **The tray no longer has a disabled item.** "Open Dashboard" was disabled
  until a probe said the server was ready, so on a broken machine the one
  thing on the tray could not be pressed. It is "Open Subshell Server" now and
  always enabled, because `open_home` answers for both states of the machine —
  which also retired `set_server_ready` and the `DashboardItem` it held.
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
- **`min_inner_size` is 360×240, a third of what it was.** It used to be
  1024×640, pinned to `useIsWide()` — `matchMedia("(min-width: 1024px)")` —
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
- **`service status` reports launchd/systemd VERBATIM, and the page passes
  it through.** `launchd: spawn scheduled` is the crash-throttle wait — the
  service IS the one you installed and it IS trying; a manager command that
  fails for any reason other than "Could not find service" (exit 113) answers
  `state: unknown` with the stderr in `detail`, which the page shows in
  red. A manager that would not answer is not the same fact as a stopped
  service, and flattening the two is how the 2026-09-07 crash loop read as
  "stopped" with no explanation.
