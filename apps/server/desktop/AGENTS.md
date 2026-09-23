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
probe rather than the stored flag: `boot_window(pref, &Probe)` answers
`WindowChoice::Main` on a `ready` probe and `WindowChoice::Wizard` on anything
else. So a machine whose server is already running opens the **dashboard** —
including one provisioned entirely from the CLI, on its first app launch,
because the boot probe answers `ready` before the branch runs.

**The launch preference moves that ready arm, and only that arm** (operator
ruling 2026-09-23). `settings.json`'s `openOnLaunch` is `dashboard` (the default,
and what every file written before it means) or `assistant`. A machine that is
NOT ready has no dashboard to open, so it comes up on the assistant whichever
way the preference is set — the preference answers the question "which of two
working windows?", not "is there one?". It is set from a row inside **How Your
Server Runs**, and that row saves on the press rather than waiting for the
screen's Apply: one settings field whose effect is the NEXT launch stops no
service and uninstalls no definition, which is what Apply exists for. The two
commands are `desktop_launch_window` and `desktop_set_launch_window`, both
`wizard`-only. **`open_home` ignores the preference**: the tray's two doors, the
Dock reopen, the single-instance relaunch and the SPA's pill each answer for the
machine, and a stored choice quietly re-pointing "Open Control Plane In App"
would make that label a lie.

**One thing outranks that choice**: `control::boot_resume` finding an update
whose second half never ran, which opens the assistant at `update` instead
(spec 2026-09-18 § 4.2). It has to outrank — a machine whose server is running
answers `Main`, which would open the dashboard over an act the person started
and never show the screen finishing it — and it costs that machine nothing,
because dismissing the screen hands off to the dashboard anyway, through the
page's ordinary ready path.

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
server's origin moved.** A port changed from the SPA's Networking page (the
Addresses card, there since 2026-09-17; on Service before it) and a
restart later, the dashboard is a window fetching a dead port, and nothing was
watching for it. `origin_changed(current, probe)` is pure and tested; the
navigate goes through `windows::open_main`'s existing existing-window branch,
which also re-validates the origin against the two this app may point at and
recomputes the window's trust flag. It refreshes the configured base URL on
every tick as well (spec 2026-09-18 § 15): that address is the second trusted
origin, and an admin can move it without moving the port this function watches.

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
the family — pure and tested without a webview in `ui/src/lib/wizard-state.ts`.
The dot row is gone (spec 2026-09-17): with one automatic screen there is no
journey to count, and the row that counted screens the person never saw was
the defect the removal closed.

**The rail is for the standing screens, and only for an onboarded machine**
(wave 2; the operator's ruling: "i do not want a sidebar applied to the FTE").
`railFor(route, onboarded)` in `lib/server-state.ts` is the rule as data: the
five sections — **Status**, **Update**, **Service**, **Addresses**,
**Reset** — appear only when the machine is onboarded and the route is one of
the standing kinds, and they answer `null` for the FTE family (welcome, tmux,
setup, handoff), for the permissions screen, for boot, and for ANY standing
route on a machine mid-first-run. Reset is the
fifth section and the DESTRUCTIVE one (operator ruling 2026-09-22, live
screenshot): the DOOR moves into the rail — `onSelect("reset")` is
`openReset`, the paired open-and-arm (it sets NO route; the dialog renders
outside the routed frame) — styled in the destructive
token. The same day's LAYOUT ruling put the reset
CONFIRMATION on the standing section itself (rail-highlighted, the sidebar
present); the 2026-09-23 wave superseded that, mirroring the now-proven
client: `onSelect("reset")` opens a centered **DIALOG** over whatever section
is up, so host.tsx's `data-route` keeps the section's kind and the Reset rail
highlight while the confirmation sits on top, overriding nothing — this
removed the last frame-replacing screen. The dialog is MODAL (a fixed overlay
across the window, positioned by class because the CSP has no
`unsafe-inline`), so it covers the rail and no navigation is reachable beside
it; the safety property that used to live in "withhold the rail while running"
now lives in the dialog being **inert to its own dismissal** — while `busy ||
running` Escape and the backdrop route through an `onClose` the dialog makes a
no-op, and the Cancel button is `disabled`, so nothing dismisses a chain that
is deleting this server. A half-run keeps the dialog open with its step log and a **Retry
reset**; a success closes it and returns to the standing journey. A
deep-linked reset arms the dialog show-first, and the handoff auto-open is
guarded so a ready machine cannot bury its own confirmation under the
dashboard. With the sidebar
present the rail is also the navigation: the
standing screens' own leave buttons (Back on Service, Back on
Addresses, Close on Update) render only where the rail does not — a
requested screen over a mid-first-run machine has none, and there the leave
button is still the only way out. That last case is the
old page's allowance — a requested update could render over a first run — and
wave 2 keeps the render but takes away the rail: the exclusion is about the
machine's journey, not about who asked. The rail is the shared
`@internal/assistant` `Rail` primitive, and its look is the SPA sidebar's,
down to the nav-gradient tokens (`--nav-active-*`) this app's stylesheet
carries value for value with the web app's.

**First run is zero-touch** (spec 2026-09-17 § 4): the page FIRES the setup
chain itself — the progress checklist is the first screen. It does NOT open the
dashboard by itself when the chain that ran HERE finishes: a pane that
navigates away at the moment it turns into an answer is jarring whichever way
the run arrived, so the completed checklist holds under *Subshell Server Is
Ready* until the person presses **Continue** (operator report, 2026-09-17,
restoring what § 4.2 had deleted the same day — `handoffView` carries both
rulings). A run this window did NOT start still hands off by itself: reopening
over a running server, or a recovery Start, has no result owed to a reader.
`ranSetupHere` is page state because the `ready` probe cannot say it — the
probe flags `onboarded` on the very read that reaches the handoff, so the flag
that gates the press has to be remembered by the window that ran the chain.
**On a Mac's first run that press hands off to the permissions screen rather
than to the dashboard** (operator's call 2026-09-18, spec § 10 — the reversal
of D3), and that screen's own Continue does what this one used to.
`permissionsAfterSetup` is the pure fork and takes three facts: darwin,
`ranSetupHere`, and `ranFirstRunHere` — captured in `startSetup` BEFORE the
chain, because by handoff time every machine looks onboarded, and without it a
recovery Set Up would re-explain macOS to a machine that has seen all of it.
The one ACT before it is Install tmux, shown ONLY while
tmux is missing (the old always-shown rule existed to keep the dots honest;
the dots are gone); the poll seeing tmux re-resolves PAST the intro to the
chain and it fires. **A failed install is a state that screen renders**
(spec § 11): `tmuxInstallFailure` forks on the result AND on whether tmux
turned up, so an install that exits zero and changes nothing is reported as
loudly as one that exits non-zero — that case used to be indistinguishable
from a button nobody had pressed. The card carries the app's own headline, the
manager's last word, and both streams behind Show output; the button relabels
to **Try again**, which re-probes before it spawns anything, and the one line a
person can paste appears under it. **Welcome leads the first run again** (operator's call
2026-09-18, one day after D1 deleted it: "reset / initial state should always
show it again" — the probe-derived list restarts on its own, and a completed
reset re-arms the fired-this-load latch through `host.rearmFirstRun`; a
cancelled one does not, and the pins in `wizard-state.test.ts` hold both
halves). The intro is inert by construction: the auto-fire lives in
`renderSetup`, which Welcome does not render, so nothing touches the machine
until the press. Permissions are back, AFTER the chain rather than before it
(§ "macOS permissions"). A port conflict, a
busy gate, or a no-bundled build lands on the pre-filled form instead of
failing a chain nobody pressed — `autoSetupDecision` is the pure fork,
`canSetup` the one refusal predicate, and the page holds fire until the port
is MEASURED. `setupRows`/`failureLine` hold the checklist and the failure
line. Agents are not asked about here; the SPA's `/setup` owns that question,
because detection lives in the server.

**Recovery** is ONE screen, where the console was five sections. The title IS
the diagnosis — *No Server Found*, *Your Server Isn't Responding*, *Your Server
Needs Its Configuration*, *Your Server Isn't Installed as a Service*, *Your
Server Is Stopped* — and there is one primary action under it rather than a row
of three the reader has to choose between. `recoveryTitle` and `recoveryAction`
own both, and `lib/recovery-model.ts` owns the subtitle and the facts. The
pre-boot facts (binary and its rung, config file, service definition, manager
state and detail, log location), the server's own log tail, the last action's
verbatim output, and what this app itself is render INLINE under the diagnosis
(operator's ruling, 2026-09-22, wave 2: what was the Show Details disclosure
is part of the Status section, not a disclosure — a sidebar section that hides
its own facts behind a second control is two navigations for one answer), and
the log tail is pulled while the Status section is up, not while it is not —
the open-disclosure rule carried over under a new name. A standing Status on
a READY machine is this screen, with one primary **Open dashboard** action
(the 2026-09-23 wave): it no longer routes to the handoff and auto-opens, so
selecting Status to LOOK at the server never bounces the window into the
dashboard. Only ARRIVAL (a window opened with no screen chosen) hands off and
auto-opens; the old `held`-handoff arm and `selectHeldHandoff` are gone. On a
NOT-ready machine the same rail item shows this screen in its diagnosis role,
exactly as before.
The other three doors the old screen stacked under its diagnosis (**Update
Subshell Server**, **How Your Server Runs**, **Server Addresses**) are the
rail's sections now, which is what those links existed to be a stand-in
for — and Reset is a rail section too (operator ruling 2026-09-22): the
door is the sidebar's destructive item, and selecting it opens the
confirmation DIALOG over the standing section (the 2026-09-23 wave; see the
Reset paragraph above), not under the rail as the same day's earlier layout
ruling had it.

**A requested screen is routed off `REQUESTED_SCREENS`, never a literal.**
`screenForRequest` (in `lib/wizard-state.ts`) maps the payload, and the reason
it is a function rather than a ternary at the call site is that the ternary
was wrong three times: `reset` was dropped when it was added, and
`supervision` when IT was added — each time raising the assistant onto a
screen it did not recognise, which then bounced the user back to the dashboard
they had just pressed a button on. Adding a screen means the Rust enum and
that list; there is no third place to forget.

**ONE screen says "update", and it does both halves** (spec 2026-09-18).
There were two — *Update Your Server*, which installed the bundled
`subshell-server`, and *Update Subshell Server* (`app-update`), which replaced
the `.app` or the `.deb` and relaunched — and they were never two acts. Every
desktop bundle SHIPS the CLI it wraps, so the second CONTAINED the first: a
person who updated the app met, on the next boot, a probe finding a bundled
server newer than the installed one, and was asked again. The names differed by
a possessive. `Screen::AppUpdate` and the word `app-update` are **deleted, not
aliased** — this product has no installed base to keep compatible, so a caller
still sending that word falls to `Home` where it can be seen. See "Updating in
one act" below.

**Update Subshell Server**, **Reset**, **How Your Server Runs**, **What macOS Will Ask** and **Server Addresses** are never in `screensFor`'s list. They are
entered by REQUEST — a `desktop-screen` event (a LIVE window), the `desktop_pending_screen` pull (a window still coming up, which is also how the BOOT resume routes) — carrying a member of the closed
`reset::Screen` enum (`home` | `reset` | `update` | `supervision` | `permissions` | `settings`; `home` parses to "whatever the probe implies") — which is what lets one
appear over a first run as readily as over a recovery without either family
naming them. A requested screen outranks the ready handoff in `render()`, or
the SPA's Update deep link would bounce the window straight back to the
dashboard it was asked to leave — and, since 2026-09-18, a machine that came up
to finish an update would open the dashboard over it and never show the
screen at all.

**Server Addresses** is the newest of them (spec 2026-09-18 § 14), and the
only one the dashboard never names — because the machine it exists for is one
whose dashboard cannot be REACHED, and these four values are otherwise
editable only from that page. The assistant is the way out structurally rather
than conveniently: it is the BUNDLED page, it drives the CLI rather than the
API, and it therefore needs no session. Read the app's own rule in the other
direction — *if the act is what makes the server unreachable TO YOU, the page
the server serves cannot be where you undo it.*

**The case it was BUILT for is fixed, and the fix is worth reading before the
screen** (operator's report, 2026-09-19). Saving an `https://` base URL used to
sign this app's window out for good: better-auth marks the session cookie
`Secure` for an https `APP_BASE_URL` (measured, 1.7.1) and the window only ever
opened on `http://127.0.0.1:<port>`, which cannot keep such a cookie. § 15 had
taught `trust.rs` to trust the configured address and let the window FOLLOW a
sign-in there — but nothing ever POINTED it there, so an operator who set an
https address got a dashboard that explained why it would not sign in and could
do nothing about it. The trust half was necessary and was not sufficient.
`Probe::window_origin` is the other half: the window opens on the configured
address when that address is https, and on loopback in every other case. What
the person sees is a restart and a fresh sign-in on the new origin, which is
what the card now says.

What is left for this screen is the case with no other answer: an address the
operator configured and this machine CANNOT reach — a tunnel that is down,
split-horizon DNS, a typo — where the window lands on a browser error and the
dashboard is not there to correct it from. That is rarer and it is exactly the
shape the screen was designed for.

Four things hold it up:

- **No new Tauri command, and that was a requirement rather than an outcome**
  (§ 14.2). Save goes through `desktop_setup` and Restart through
  `desktop_service`, both already granted to `wizard`; `ipc-acl.test.ts`'s
  exact-set pin is therefore untouched. A screen that needed a fresh grant
  would have widened the IPC surface in the name of fixing a lockout.
- **It sends the machine's OWN supervision, every time** (`settingsSupervision`).
  `desktop_setup`'s `supervision` argument is optional and its absence means
  "a background service, armed for login" — today's first-run chain — so a save
  that omitted it would install a service on a machine deliberately left in app
  mode, as a side effect of editing a port. What the chain still does beyond
  writing config.env is install the bundled server where it is newer than the
  installed one; that is the update screen's own act rather than a new one, and
  it is stated at `settingsPayload`.
- **The https sentence is the DASHBOARD's, verbatim** —
  `apps/server/web/src/components/networking/addresses-card.tsx` renders it at
  the same field, and `settings-screen.test.ts` reads that file and pins the two
  equal. Someone who lands here has already met the consequence; two wordings
  would read as two problems.
- **The Force box is the update act's box**, moved to `lib/pane-force.ts` when
  the second screen needed it: same sentence, same fail-closed `paneRisk`, same
  unticked default. This restart IS that restart.

Its doors are the TRAY (**Server Addresses…**, which raises the bundled page
through `arm_and_raise` and so works with the server down, stopped, or running
and refusing every sign-in) and the recovery screen's link. Not the dashboard,
which is the point. `SETTINGS_LABEL` is one string across both doors and the
screen's own title, and the tray's Rust copy is pinned to it by an
`include_str!` containment test; it is deliberately NOT "Server Settings",
which is the View menu's ⌘4 into the SPA's settings routes — the pages that
need the session this screen exists to get back.

**Show Details keeps its openness in PAGE state**, not the element's.
`#content` is rebuilt on every render and the poll renders every 1500 ms, so a
`<details>` whose state lived only in the DOM collapsed under the reader twice
a second. The failure screen had exactly that defect from the day it shipped.

The window is **1024x720, fixed and not resizable**, and `open_main` takes its
position and size when the dashboard is created, so the swap reads as one
window changing screen. The SPA's `/setup` no longer continues a native dot
row when it sees the desktop UA marker — there is no native row to continue
(spec 2026-09-17); its row counts its own steps on every shell.


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
rule: Subshell Client's node CLI has its own service and no equivalent mode,
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

## Installing the bundled server is a TRANSACTION, not a copy

**`desktop_install_server` has two paths, and the split is whether there is an
installed CLI to ask** (spec 2026-09-15 § 7.1):

- **A REPLACE of the managed copy** (`probe.managed` — the binary this machine
  actually runs IS `~/.local/bin/subshell-server`) runs
  `<installed> update --from <staged sidecar> --yes --no-restart --json`. What
  that buys is the whole reason the verb exists: the database is backed up,
  `pending.json` is written, `<binary>.previous` is kept, and the NEW binary
  either completes the transaction at boot or reverts it. Before this, the
  desktop replace was the one update path on the machine with no backup behind
  it and nothing to roll back to.
- **A first install** keeps `sidecar::install_bundled`. There is no installed
  CLI to run, and writing a file where none was is not a transaction.

Three details that are not obvious from the diff:

- **`install_server_now` is the wrapper, `install_bundled_server` is the act.**
  The wrapper exists for one line: an install that SUCCEEDED clears the update
  marker (spec 2026-09-18 § 5), because the marker means "the CLI this app
  ships is not installed yet" and that has stopped being true. Every door — the
  update screen's press, the boot resume, the first-run chain — goes through
  the wrapper, so "the bundled CLI is installed now" has one writer rather than
  one per caller. A FAILURE leaves the marker, which is what lets the next boot
  try again inside the attempt bound.
- **The flags are a CONTRACT, held in one place.** `desktop-core`'s
  `cli_update::update_args` spells them for both apps, and its tests pin the
  exact list. `--yes` because the consent happened on the screen that named the
  versions; `--no-restart` because only the app can take the restart in app
  supervision mode, and because the node app deliberately never restarts.
- **The old `stop_first` closure is gone, and nothing lost a guarantee.** It
  only ever fired when `probe.managed` was true — exactly the path that now
  goes through the CLI — and the CLI's swap is a `rename(2)` a running process
  does not notice.
- **A server older than the verb falls back to the plain copy, and SAYS so.**
  Every `subshell-server` that existed on 2026-09-15 predates `update` — 0.6.0
  was cut before it was written — so without a fallback the app's offer would
  fail with a usage dump on exactly the upgrade it exists for. The fallback is
  `install_bundled`, the same `rename(2)` swap this path used before, and the
  screen carries `legacy_install_summary`'s sentence: *Installed 0.7.0 over
  0.6.0. No database backup was taken: the previous server predates the update
  command, so this install cannot be rolled back automatically.* Naming the
  missing backup is the whole point — someone who later needs to undo this has
  to learn it now, not when they go looking for a `.previous` that is not there.

  **What makes that safe is how NARROW the detection is.**
  `cli_update::lacks_update_verb` requires the run to have finished (`code`
  is `Some`), to have failed, and to carry `unknown command 'update'` in its
  own output — the marker only a command dispatcher prints, for a word it does
  not know. It is keyed on the MARKER rather than the exit code because the
  two CLIs disagree: `server-v0.6.0` exits **1** (`error(USAGE); exit(1)`) and
  `node-v0.8.0` exits **2** (`fail(2, UsageError)`), both measured at the tags.
  Every other failure — the pane guard, an unwritable binary, a digest
  mismatch, a version the file does not confirm, an update already in progress
  — is still a failure, because falling back on any of those would skip the
  backup while reporting success. `classify_update` is split out from the run
  precisely so that decision is testable without a test able to reach
  `install_bundled` and write into someone's own `~/.local/bin`.

## Updating in one act

`src-tauri/src/app_update.rs`, `tauri-plugin-updater`, `control::boot_resume`,
and the one `update` screen (spec 2026-09-15 § 7.2; spec 2026-09-18).

**One press updates the app AND the server that app ships**, because on a
desktop machine those were never independent: each bundle SHIPS the CLI it
wraps, so `desktop_install_server` installs precisely the copy a new bundle
would bring. The act is **two phases separated by the relaunch**, and the order
is forced rather than chosen — the new app carries the newer server, so
installing the server first installs the OUTGOING bundle's copy and leaves the
machine behind again the moment the app lands.

**It is a SELECTION, and that is not a reversal** (spec 2026-09-18 § 13). The
screen is a table: one row per component — what it runs, what it would become,
and a checkbox where there is something to do, ticked by default — plus one
Force box below it. With both halves behind, both are ticked and one press does
both, which is the paragraph above unchanged. What the table adds is the case
where the two halves point in DIFFERENT directions, and it was a real machine:
an operator at app 0.8.1 with a `subshell-server` they had updated by hand to
0.10.1 was told the screen would install a server older than the one they were
running. The CLI row was pushed whenever the app was behind, and the subtitle
promised "installing it also installs the server it ships", while the ladder's
answer was `adopt-installed` — so phase 2 would have answered `Resume::Clear`
and installed nothing. The ACT was never unsafe; the DISPLAY was false.

Three rules the table keeps, each with the defect behind it:

- **A row with nothing to do states WHY, never a disabled checkbox.** "Not now"
  with no reason is what sent the operator looking for a bug. The cell is short
  ("you run a newer one", "not this app's", "could not check", "up to date");
  the long form is a sentence under the table, which is what `notes` is.
- **Force governs the pane-safety refusal and nothing else.** It is the one
  refusal a person may overrule, it is UNTICKED by default — an override that
  arrives pre-accepted is not an override — and it renders only where a
  definition would actually refuse. It may **never** install an older bundled
  CLI over a newer installed one: boot's migrator is forward-only, so that is
  data loss rather than a choice to present, which is why the adopt-installed
  row explains `subshell-server update --from <file>` instead of offering a box.
- **The selection crosses the relaunch as the marker's PRESENCE.** A cleared
  CLI row writes no `PendingBundledInstall` at all, so phase 2 does not run —
  there is no second field for the two to disagree about. That is why
  `desktop_install_app_update` takes two booleans now (below).

| | phase 1 | phase 2 |
|---|---|---|
| runs in | the process the person pressed in | the build that came up |
| does | download, verify, install the bundle | install the bundled server, restart the service |
| ends by | writing the marker, then `app.restart()` | clearing the marker |

Four things about the seam:

- **The marker is written BEFORE the relaunch, never after** (`app_update::install_app_update`,
  in the same `SettingsState::update` that clears the stale notice — one lock,
  one save). A crash between the two must leave a machine that knows what it
  was doing. `PendingBundledInstall` and the pure `resume_decision` live in
  `crates/desktop-core`, shared with Subshell Client; what each app DOES with
  `Resume::Install` does not, because this one restarts a service and that one
  deliberately does not.
- **The marker converts an OFFER into a continuation and never decides there is
  work.** `resume_decision` re-asks the machine — the bundled version against
  the installed one, the same comparison `decide_server` makes — so a marker
  whose work turns out to be done (a hand `subshell-server update` in between)
  is cleared without acting. It is therefore impossible for a marker to cause
  an install the probe would not have offered anyway.
- **The attempt is counted at the FIRE, not at the offer** —
  `install_server_now`, the one door every install goes through, spends one
  before it acts, and `boot_resume` counts nothing. It counted at the offer
  until 2026-09-18, which made `MAX_RESUME_ATTEMPTS` (2) a bound on BOOTS: two
  launch-and-quits reached the limit having never attempted an install, and the
  screen then said the install had failed twice (review). Counting before the
  act still spends one on a crash INSIDE the install, which is the case the
  bound exists for, and it is where Subshell Client counts too. At the limit
  the marker STAYS — so the screen can still name the update and offer Try
  Again — and nothing fires by itself.
- **The pane-safety consent crosses in the marker's `forced`.** The confirm
  happens in phase 1 and the restart it consents to happens in phase 2, in
  another process, so re-asking would be asking again for something already
  granted on a screen nobody chose to open. It is the page's Force box that
  answers now (§ 13.2) — it used to be read in Rust at the press, on the
  grounds that the command took no argument — and Rust still NARROWS it:
  `install_app_update` ANDs the page's answer with `control::pane_risk_now`,
  the twin of the page's `paneRisk`, so a page asking to force a restart no
  definition would refuse gets an ordinary one. A Try Again on the phase-2
  screen is a FRESH consent, and the box is live under it, seeded from what the
  marker recorded.

**Two things here differ from Subshell Client STRUCTURALLY**, and both are
worth stating because the two apps' docblocks would otherwise read as
contradicting each other (review, 2026-09-18). The wire names are NOT among
them: `pendingInstall`, `halted`, `{ fromAppVersion, forced, halted }` and the
Rust `PendingInstall` are this app's spelling and the shared one.

- **Who raises the screen.** This app decides at BOOT, in Rust (`lib.rs`'s
  `setup`, through `boot_resume`), because a ready machine would otherwise
  open the dashboard and never show the assistant at all. The client decides
  in the WEBVIEW, and that is sound there for a reason worth recording rather
  than assuming: `windows::open_at_startup` always opens its node window, so
  a page that can raise the screen is guaranteed to exist. Were that to
  change, the client would need this app's boot branch.
- **Who clears a marker whose work is done.** Here `resume_view` is READ-ONLY
  — a poll that merely renders never writes — and `boot_resume` is the one
  place a spent marker is dropped. The client's `resume_view` clears it on the
  poll instead. Both are defensible; this one is the stricter rule, and the
  cost is that a marker which becomes pointless while the window is open
  survives until the next boot, where it reads as `None` anyway.

The screen itself is `ui/src/lib/update-act.ts` — pure, every judgment, and
the only thing in this app that CAN be tested, since `ui/src/__tests__/` has
no DOM harness. `install_server_now` is the one place the marker is cleared on
success, which is why the act itself moved into `install_bundled_server`:
every door (the press, the boot resume, the first-run chain) installs through
the wrapper.

Four more things carry the weight of the app half specifically:

- **The plugin is pointed at ONE release, chosen here.** It wants a static
  manifest URL, and this repository publishes four components under four tag
  prefixes — so `check_app_update` reads the same release LIST every other
  component reads (`desktop-core`'s `release_feed`, whose `RELEASE_API` is
  held equal to `packages/subshell-protocol/src/releases.ts`'s
  `DEFAULT_RELEASE_API` by an `include_str!` test), picks the newest
  `desktop-server-v*` by SEMVER, and only then sets
  `endpoints([<that release>/latest.json])`. `SUBSHELL_RELEASE_URL` repoints
  the list; an EMPTY value turns the whole thing off, the same air-gapped
  answer the server has.
- **The trust is a compiled-in public key**, so a compromised release host can
  WITHHOLD an update and cannot supply one. That is strictly stronger than the
  CLI path, where the digest and the bytes come from the same source.
- **The launch check is once a day and opens nothing.** `settings.json`'s
  `lastUpdateCheckAt` / `lastUpdateVersion` are the whole mechanism
  (`release_feed::due_for_check`); the only output is the tray item's label.
  A window that appeared on its own because a release was cut is the automatic
  update this design explicitly does not have (spec § 14).
- **The tray item is two labels and ONE act: it opens the screen**
  (operator's call, 2026-09-18, replacing spec 2026-09-17 § 5.2's branch).
  `update_label()` stays pure — "Update available — Subshell Server {version}"
  once a check knows, "Check for Updates…" otherwise — but both press through
  to `arm_and_raise(update)`, so the label announces and never re-routes.

  It used to branch, and the quiet half was a dead end. An unknown version ran
  `check_now`: a forced background check that opened NOTHING, whose whole
  answer landed on this item's own label — which the press had just closed the
  menu on. So a machine with no update known gave no visible response at all,
  and one with an update waiting took two presses with a menu reopen between
  them. Signed in that is merely poor, because the SPA's footer row says the
  same thing and its `[Update]` opens this screen; **signed out there is no
  sidebar, so the tray was the only door to updating and it led nowhere.**
  Reported 2026-09-18 on an app at 0.8.0 with `desktop-server-v0.10.1`
  published, a reachable release source, and a stored `null` from a check that
  had honestly found nothing hours earlier — three facts that each look like
  the bug and none of which was.

  Opening is strictly MORE than the check was rather than a different act: the
  screen runs `runUpdateCheck(false)` on entry and renders checking / up to
  date / available with the install press, so "Check for Updates…" opens a
  window that checks, which is the macOS convention. `check_now` is deleted
  with the branch — the forced check lives where its answer is visible.
- **The dashboard can now SEE the stored answer** through `desktop_app_update`
  — the read-only seventh `main` command: no argument, no fetch,
  `{ currentVersion, availableVersion }` from `PackageInfo` and the one
  settings field the check writes. It never checks; both update VERBS stay
  `wizard`-only (spec 2026-09-17 § 5.3; `docs/security.md` carries the
  accounting).
- **The check does NOT ride the 1500 ms poll.** Every other fact on the
  assistant is a probe of this machine; this one is a third party. The screen
  asks on its first render and on Check Again, and nothing else.

**Both commands are `wizard`-only**, and the check is there too even though it
looks harmless: its sibling replaces the application, and the dashboard reaches
this screen by NAME (`desktop_open_assistant({ screen: "update" })`) — a
grant it already has. Neither names a LOCATION, which is the whole of the case
for granting them: the release is re-resolved in Rust, so the page asks for
"the newest" and can never name a URL. `desktop_check_app_update` takes no
argument at all; `desktop_install_app_update` takes exactly two booleans, the
§ 13 selection (`forced`, `install_server`). `ipc-acl.test.ts` pins the
parameter list of each and that every argument past the handle is a `bool` — a
`String` there is the parameter this pin has always existed to catch.

**The signing key is the operator's, and losing it is unrecoverable.** One
keypair for BOTH desktop apps — they are one publisher, and a public key is
the publisher's identity rather than the app's:

```bash
bunx @tauri-apps/cli signer generate -w ~/.tauri/subshell-desktop.key
```

`@tauri-apps/cli` by name, not `tauri`: from outside a desktop app directory
`bunx tauri` falls through to npm's retired v1 CLI, which depends on `sharp`
and fails compiling libvips on arm64 macOS (measured 2026-09-15).

The `.pub` contents go into `plugins.updater.pubkey` in BOTH apps'
`tauri.conf.json`, replacing the committed
`REPLACE_ME_WITH_THE_SUBSHELL_DESKTOP_MINISIGN_PUBLIC_KEY` placeholder (which
`assertUpdaterPubkey` in `src/scripts/release.ts` refuses a cut over). The
private half goes into two repo secrets:

| secret | value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the key file's **CONTENTS**, not a path — measured 2026-09-15, tauri 2.11 ignores `TAURI_SIGNING_PRIVATE_KEY_PATH` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the passphrase, or `""` |

**The `.key` in your password manager IS the backup**, exactly as the `.p12`
is. **Losing it means every already-installed app can never auto-update
again** — a new key is a new publisher as far as those installs are concerned,
and the only way back is for every user to download the app by hand.

One local cost, worth knowing before it surprises you: because the pubkey is
configured and `bundle.createUpdaterArtifacts` is on, **`bun run compile`
needs `TAURI_SIGNING_PRIVATE_KEY` set** — tauri refuses with "A public key has
been found, but no private key". Generate a throwaway key for local bundling;
`tauri dev` is unaffected, because it bundles nothing.

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
re-probes, sees `onboarded: false`, and draws first run in place — from
Welcome, re-armed for the press (§ "The assistant"). Release
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

**The Reset screen fills the frame on the confirmation, and replaces it for
the chain** (operator ruling 2026-09-22, final word on the layout,
superseding "replaces the frame rather than filling it"). The confirmation
rides the rail — the sidebar stays, reset active — and the pane's title
lives in the frame's `shell("reset")`, keyed on the meter pane. The room is
the RUNNING chain: for `busy || running` the rail is withheld and the view
goes full-window again, because a Back button live through a chain that
stops a service and sweeps sockets is a way out from under a screen that
has none. The safety property did not move; it moved DOWN, to the chain.

**Its label names what is reset.** `RESET_LABEL` is one string, used by the
recovery footer and carried verbatim by the frame's reset title
(`shell("reset")`), and it is
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

## macOS permissions (spec 2026-09-14)

A first run on a Mac meets four system prompts or banners. THREE of them are
the app's own to raise: Notifications, and — since 2026-09-17 — Photos.
Files-and-Folders is attributed to whichever process lists the folder
(`subshell-server` under launchd, this app under "runs with this app"), and
Background Items is a banner, not a permission. So the `permissions` screen —
macOS only — shows THREE rows, REQUESTS the
two it owns, EXPLAINS the one it cannot, and never blocks Continue. It left the first
run with spec 2026-09-17 (the TCC prompt it explains belongs at the moment a
permission is first wanted, not at launch) and came back on 2026-09-18 on the
far SIDE of the setup chain (spec § 10): the ready screen's Continue hands off
to it, on macOS, on a first run, once — so nothing is asked of anyone until
there is a running server to be notified about, and the dashboard's notices
remain its other door.

It is still reached ONE way. `permissions` never left `REQUESTED_SCREENS`, so
the handoff names it exactly as a dashboard notice does and
`isRequestedScreen(screen)` remains the whole routing — the render's old
dual-role disambiguator stays gone. What the screen has to know is which door
it came through: from a notice there is somewhere to go BACK to, and from the
handoff there is not, so it carries a primary **Continue** that opens the
dashboard in place of the ghost Back.

**The fourth row — Background Items — was removed on the operator's request,
and the reason is worth keeping** (it is the same reason the second rule below
exists). The banner is real: starting at login does add Subshell Server to
Login Items and macOS says so. But the row had no state to read, no pane to
open and nothing to press, so it could never change — and a row that can never
change is not information, it is prose standing in the column a person reads
for decisions. Where the banner appears the sentence belongs: the login
screens that arm it.

**The Photos button is not a second door to the same room, and that needed
proving.** The screen shipped with the row EXPLAINED and never ASKED (spec
2026-09-14 § 9): the system raises the prompt at the moment an image is picked,
which is where Apple puts it. What makes asking here sound rather than merely
possible is recorded in `desktop-core`'s `request_photos` — **the panel that
normally raises this prompt is THIS app's own image picker**, running in this
process, and `Info.plist` already carries the `NSPhotoLibraryUsageDescription`
sentence the sheet shows. So a sheet raised on this screen arms exactly the TCC
subject the picker would otherwise arm later: one question, asked where it can
be explained. The ask is at `PHAccessLevel::ReadWrite`, the SAME level
`photos_permission()` reads, so the sheet and the row answer one question, and
the answer is RE-READ from that function rather than mapped from the handler —
this row renders the difference between `authorized` and `limited`, and one read
keeps that mapping in one place.

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
  and in `capabilities/main.json`'s own comment. Everything that ACTS stays
  `wizard`-only: `desktop_request_notifications`, `desktop_request_photos` and
  `desktop_open_system_settings` (which takes a closed `SettingsPane`, never a
  URL, the `WebTarget` shape). The two requests take NO argument either —
  pinned in `ipc-acl.test.ts` beside the read's own no-argument pin — so
  neither can be aimed at a permission the screen did not name. And each has a
  `#[cfg(not(target_os = "macos"))]` stub answering `Unavailable`:
  `control.rs` names them on every platform, and **`cargo clippy` on a Mac
  cannot see what Linux compiles** — a missing stub is a Linux build failure
  that ships green from a laptop.

`src-tauri/Info.plist` carries the four usage descriptions; they are the
sentence a prompt attributed to THIS APP shows, and a prompt attributed to
`subshell-server` under launchd shows none, which is what the `files` row's
attribution sentence is for. The row model is pure
(`ui/src/lib/permissions-model.ts`): every `Permission` value to a glyph state,
a suffix and an action, and which pane each row opens.

**Every row the dashboard sends someone to has something to press when they
arrive**, and that is a SECOND rule beside "a button only where pressing it
does something" — read as one rule, they produce the dead end this screen
shipped with (review, 2026-09-14). The two are about different buttons: macOS
asks once, so **Allow** is inert after the first answer and is offered only
while the state is `not-determined`; **Open System Settings** is never inert,
because the pane is there whether or not the question has been asked. So the
`files` row offers it in EVERY state — its own state is unreadable by
construction, so a button gated on `denied` would render never, while the
picker's "Blocked by macOS" notice raises this screen as the fix regardless.
`SettingsPane::FilesAndFolders` being defined, granted and sent by nothing was
the tell. `photos` now follows `notifications` exactly — **Allow** while
`not-determined`, **Open System Settings** once `denied`, nothing once allowed —
because it has a prompt of its own to raise now (see above), and its notice
fires in the `denied` state the pane answers.

**A second rule came out of the same screen: an `allow` row carries its own
button WORDS.** The renderer used to hardcode `("Allow notifications",
allowNotifications)` for `row.action === "allow"`, which was true of one row and
became a lie the moment two rows could ask — the Photos row would have shown a
button naming notifications and spent the Photos question. So `PermissionRow`
carries `allow: { label, request } | null` (present exactly where `action` is
`"allow"`, pinned by `permissions-model.test.ts`), and `wizard.ts` looks the
handler up in a `Record<PermissionRequest, () => void>`. A `Record` over the
model's closed union, not a chain of `if`s on `row.id`: a third request added to
the union without its handler is a COMPILE error, where dispatch defaulting to
notifications is a button that lies and a test nothing fails.

**The three enums that cross as WORDS are pinned to Rust's own spelling** —
`WebTarget` and `SettingsPane` (`control.rs`), `Permission` (`desktop-core`) —
by `ui/src/__tests__/wire-names.test.ts`, which derives the serde wire names
from each enum body and compares them against `lib/ipc.ts`'s unions and the
SPA's hand-written `types/permissions.ts` mirror. The test was born from
`MacPorts` going across as `mac-ports`; `Permission` is the worse case it now
also covers, because it travels TOWARD the page — a drifted word there is not
a refusal with a message but an `undefined` falling out of an exhaustive
switch, rendering a blank row with no error anywhere.

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
│   │   ├── copy-button.ts   # the one Copy affordance; its flash lives in lib/copy-flash.ts
│   │   ├── tmux-warning.ts  # the amber gate explanation — a FACTORY
│   │   └── reset-view.ts    # the Reset dialog (the 2026-09-23 wave: a modal over the standing section, no longer a frame replacement)
│   ├── styles.css      # @theme tokens + component classes; Tailwind in markup
│   ├── lib/
│   │   ├── ipc.ts            # one typed function per `desktop_*` command this page invokes
│   │   ├── config-form.ts    # the pure form contract (see below)
│   │   ├── installers.ts     # the pure install plans
│   │   ├── wizard-state.ts   # screensFor, autoSetupDecision, recoveryTitle/Action, RESET_LABEL, the checklist
│   │   ├── recovery-model.ts # the recovery screen's subtitle, facts and pane risk
│   │   ├── update-act.ts     # the ONE update act: rows, phases, presses, refusals
│   │   ├── pane-force.ts     # the pane-safety Force box, shared by both screens that restart
│   │   ├── settings-screen.ts # Server Addresses: the https warning, what Save sends, its refusals
│   │   ├── permissions-model.ts # the four macOS rows: glyph, suffix, action, pane
│   │   ├── copy-flash.ts     # the Copy button's copied/failed state, by key and by clock
│   │   └── reset.ts          # the reset screen's pure decisions: rows, refusal, arming
│   └── __tests__/      # pure pins: config-form, installers, wizard-state, recovery-model,
│                       # update-act, settings-screen, permissions-model, copy-flash,
│                       # reset, wire-names, ipc-acl, tauri-config
└── dist/               # `frontendDist` — built, gitignored, never hand-edited
```

The split rule the plain-JS version established still decides WHERE logic
lives: anything with a contract rather than a rendering goes in `lib/`, where
it is testable without a webview. Everything under `ui/src/assistant/` holds
only the DOM.

Four things about that arrangement are load-bearing:

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
- **A Copy button's flash is PAGE state** (`lib/copy-flash.ts`), which is the
  third time this app has had to move something out of an element the render
  rebuilds — after `Show Details` and the reset screen's step rows. The flash
  lasts 1600 ms and the poll renders every 1500, so a tick living in the DOM
  survived a uniformly random 0–1500 ms of it: pressed, seen, gone, with
  nothing wrong and nothing to notice. The slot is keyed by a string the
  CALLER owns — the element is the thing that does not survive — and expires
  by TIMESTAMP rather than by a timer having fired, since the timer belongs to
  whichever button has already been discarded. Copy buttons are also the one
  affordance here that is never disabled, and by construction rather than by
  an opt-out: they are not built through the screens' `button()`, which is
  what the busy state reaches. (A `data-always` opt-out existed for the
  console's sweep, which read it; the sweep went with the console and the
  attribute outlived its only reader by three months.)
- **`lib/update-act.ts` holds every judgment the update screen makes**, for
  the same reason and with a sharper edge: the screen has six phases, two
  presses and four sentences it refuses in — a server this app did not
  install, one NEWER than the bundle, a release source that would not answer,
  and the automatic attempts being spent — never more than two of them at once,
  since a phase-2 screen returns before the release answer is consulted. None
  of it could be covered at all from inside `renderUpdate`. Which rows appear,
  which of them carry a checkbox and which carry a reason instead, what is
  ticked by default, whether the Force box renders, what the press is called
  and what it will do, and whether phase 2 fires by itself are all decisions
  there, and `update-act.test.ts` walks § 4.1's four cases, § 4.2's two phases,
  § 13's selection and each of § 6's refusals. The SELECTION itself is page
  state in `wizard.ts` — held as overrides, so an absent id is the model's
  default and a tick made against a row that stops existing takes nothing with
  it — because the model is pure and is handed the answer rather than keeping
  it.
- **`lib/recovery-model.ts` exists so the recovery screen's WORDS are
  testable.** Its subtitle and its facts were the console's step table and
  Details list — DOM, in a render that needs a webview, which is why neither
  was ever covered. They are data now, and `recovery-model.test.ts` covers the
  rows that only appear when something is wrong: an unresolved MCP entrypoint,
  a port answering while the service is not running, a teardown that kills
  live panes, a manager that would not answer.

**About is native now, and it owns no strings of its own** (spec 2026-09-17
§ 6). The predefined About item rides the macOS app menu; Linux, which has no
app menu, gives the DASHBOARD window a one-item menu bar carrying the same
item — muda's GTK backend renders a real `AboutDialog` from the metadata, so
the panel is not macOS-only chrome. Both read one `about::metadata()`
assembly: a pure function under test, fed the version from `PackageInfo`
(NOT `env!("CARGO_PKG_VERSION")`, which is the crate's 0.1.0 — the real
version reaches it through `tauri.conf.json` reading `../package.json`), and
the copyright, licence summary and URLs from the same
`crates/desktop-core/src/legal.rs` constants `scripts/license-fields.ts`
holds equal to the TypeScript copy and the root `LICENSE`. A third copy in
`ui/src` would still be the one the detector cannot see. The Status section
keeps exactly ONE fact from the old block — `This app — Subshell Server
{version}` — because the version belongs beside the log text a person is
about to paste into a bug report; wave 2 renders it INLINE in that section
(the Show Details disclosure is gone), and `desktop_about` keeps that line
as its last caller.
Distinct from the SPA's own `AboutDialog` (user menu → About), which is about
the product and the SERVER build: this panel is about the app binary, and it
is the only surface that knows the app's version.

**That is also why the native panel needs no command at all.** It is built in
Rust from the same constants — no `desktop_about` round trip, no URL crossing
the IPC boundary in either direction. And on a machine whose server is DOWN,
where the SPA's About dialog is unreachable, the panel is still there — which
is precisely the machine this page exists for.

## The log, and the last action's words

The console's Logs section was one region with two tabs, a caption and a
selection that had to survive navigation. None of that survives it: the
assistant shows one screen at a time, and both panes render INLINE in the
Status section, one under the other — wave 2 removed the Show Details
disclosure that used to hold them, because a sidebar section that hides its
own facts behind a second control is two navigations for one answer. A tab
strip over two panes inside a 560px column is chrome for its own sake.

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
| `wizard` | the twenty-four its page invokes — probe, port in use, setup, install tmux, install server, set the binary, set supervision, every service verb, logs, open path, arm reset, pending screen, reset, open main, open tmux docs, about, open web, request notifications, request Photos, open a System Settings pane, read the launch window, set the launch window, check for an app update, install one — plus `dialog:allow-open`, `opener:allow-reveal-item-in-dir`, and its core grant: `core:default` ALONE. `core:window:allow-close` was granted for spec 2026-09-17's **Later** button and went with it when that screen's two dismissals became one **Close** (2026-09-18) — a leave rather than a window close, so no page call to a core window verb remains. `ipc-acl.test.ts` pins the narrowed list, pins that nothing under `ui/src` imports `@tauri-apps/api/window` (the route the grant would come back through), and pins that `main` holds neither close nor the update verbs |
| `main` | `desktop_open_assistant`, `desktop_shell_ready`, `desktop_notify`, `desktop_open_in_browser`, `desktop_permissions`, `desktop_app_update`, window dragging — and `desktop_set_supervision` (below) — on a TRUSTED origin only (loopback, or the instance's configured `APP_BASE_URL`; see below) |

Six of `main`'s seven commands are chosen for what they cannot do: raise a
window at a named screen, drop this app's own title bar, display one
notification with a fixed shape, open a page of THIS server in the system
browser, and — no argument at all, two facts each — read this app's macOS
permission states (2026-09-14, argued in the macOS permissions section
below) and its own two update version facts (2026-09-17, spec § 5.3):
`{ currentVersion, availableVersion }` from `PackageInfo` and the one
settings field the daily check writes. The read NEVER checks —
`desktop_check_app_update`, `desktop_install_app_update` and every other
verb stay `wizard`-only, and the row's `[Update]` rides `desktop_open_assistant`,
a command `main` already held.
`desktop_set_supervision` — the one deliberate exception, added by operator
decision on 2026-09-12 — lets the dashboard's supervision card confirm in its
own dialog rather than raising the assistant; `docs/security.md` carries the
accounting, and `ipc-acl.test.ts` pins `main` at exactly these seven so an
eighth is loud.

`desktop_open_in_browser` (2026-09-14) is of the harmless kind and its
harmlessness is in the ARGUMENT: it takes a PATH — no scheme, no
protocol-relative `//host`, no backslash, no whitespace or control characters,
all refused by `crates/desktop-core`'s shared `browser` module — and joins it
onto a TRUSTED origin this side chose, so the page names the route and Rust
names the host. Its signature is pinned as well as its name, because an
exception is only as narrow as its arguments. A webview has no address bar and
no second tab, which is the whole reason it exists; the tray's and the View
menu's "Open in Browser" reach the same act from Rust and need no grant at all.
Two things a person will notice and that this does not try to fix: the browser
carries no session cookie from the webview, so they sign in again; and the
origin opened is whichever trusted one the window is on — usually LOOPBACK,
where a passkey works only if `APP_BASE_URL` is loopback.
Nothing else that touches the CLI, the config, the service or the filesystem
is reachable from a page the server serves. `desktop_open_assistant` takes an OPTIONAL
`screen` argument, and the SPA sends it from the Settings danger card
(`{ screen: "reset" }`), the Service page's Update card (`{ screen: "update" }`),
the permission notices (`{ screen: "permissions" }`) and the sidebar pill (no
argument). The supervision card sends none: it confirms in its own dialog and
calls `desktop_set_supervision` itself. It names a SCREEN
and never a command — raising `update` performs one read-only probe, arming
`reset` performs one `status --json` the watch already runs on its own timer,
and every verb behind either needs a press inside the bundled page.

**`app-update` is no longer a word this enum knows** (spec 2026-09-18, the two
update screens becoming one). Every sender says `update` now: the SPA's
sidebar update row (`components/desktop/desktop-app-update-row.tsx`) and its
Updates page, whose Subshell Server row is FOLDED into the Server row inside
this app (D4) and whose remaining desktop row cannot raise an assistant at all.

Deleting the id rather than aliasing it is what made that sweep finishable: the
old word parses to `Home`, so a sender left behind raises the assistant at
whatever the probe implies — visibly wrong on a machine whose server is
running, rather than silently correct until someone notices the wrong screen.
Two senders were found exactly that way while this work was in flight.

### The dashboard window's two trusted origins

**The capability's scope stopped being the boundary on 2026-09-18** (spec
2026-09-18 § 15, operator's decision with the trade stated; `docs/security.md`
§ 11.11a has the accounting). It was: `capabilities/main.json` named
`http://localhost:*` and `http://127.0.0.1:*`, `open_main` refused anything
else, and `on_navigation` pinned the window to the origin it opened with. Under
that rule a control plane behind an OAuth proxy could not be shown in this app
at all — a proxied sign-in bounces the window to an identity provider on a third
origin and back, and the window would not follow. Subshell Client was unblocked
the same way for the same report (`f1c2aa68`).

So `remote.urls` is a wildcard now (`http://*:*`, `https://*:*` — `http://*`
alone does not match a non-default port in Tauri 2.11.5's urlpattern, which
would silently exclude the default `:3080` plane), and **`src-tauri/src/trust.rs`
is the boundary**. Four facts to hold:

- **Two origins, one predicate.** Trusted means this machine's loopback (either
  spelling, http, any port — exactly what the old scope named) or the instance's
  configured `APP_BASE_URL`. `MainTrust::trusts` answers both "where may
  `open_main` POINT the window" and "may this page invoke anything", so where we
  aim it and what it may do cannot drift apart.
- **The flag belongs to the COMMITTED document, never to a page and never to a
  navigation request.** `allow_navigation` refuses any non-http(s) scheme (the
  window must not be steerable into `file:` or a custom handler) and **arms
  nothing** — it runs at request time and fires for subframes, so an untrusted
  page could otherwise arm all seven commands by aiming at a loopback port that
  refuses the connection, or by embedding an iframe. Arming is
  `on_page_load(PageLoadEvent::Started)`, which wry raises from
  `didCommitNavigation:` (macOS) and `LoadEvent::Committed` (GTK) — main-frame
  only, at commit, and before any script in the new page runs, so the SPA's own
  title-bar handshake is never refused. `open_main` sets it for the URL it
  opens a NEW window with (nothing can be invoking yet) and CLEARS it when it
  re-points an existing one; a destroyed window clears it.
- **The guard sits at the INVOKE HANDLER** (`trust::guarding` wraps
  `generate_handler!` in `lib.rs`), keyed on the calling webview's label, and is
  uniform over all seven. Not per-command, because Tauri identifies a caller
  through an injected `Webview` argument and three of the seven are pinned to
  taking no argument precisely so they cannot be aimed — `desktop_permissions`
  takes nothing at all. Plugin commands never reach the app handler, so window
  dragging still works on an untrusted page; the assistant is not subject to it
  at all, and must not be: it is the surface that repairs a machine whose server
  is unreachable.
- **The base URL is live, not captured.** It arrives as `Probe::base_origin()` —
  passed into `open_main` by both callers, and refreshed each tick by
  `watch.rs`, which already takes a probe — because an admin can move
  `APP_BASE_URL` from the Service page without moving the port, and the watch's
  own re-point trigger only watches the port.

Two Rust-side conveniences follow the same line rather than the window's current
address: `browser_origin` uses the window's origin only while it is trusted, and
`current_path` answers `/` when it is not, so a tray click mid-sign-in cannot
carry an identity provider's path onto this server's origin.

What it costs: a page on the instance's own address now holds what a loopback
page held, including `desktop_set_supervision`, and that address may be
reachable from a network. That is the operator's call. What the guard buys is
that it is not a widening to the whole web.

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
it; the value must be a loopback `http://` origin — one of the two `open_main`
accepts, and it re-checks independently; and it is applied inside `Probe::origin` rather than at the
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
carries one — it bundles a node CLI) and every older shell
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
holds exactly its seven commands plus window dragging — by name, by count, by
SCOPE, and for every one that takes arguments, by Rust signature — the two
reads, `desktop_permissions` and `desktop_app_update`, pinned to an EMPTY list.

**The SCOPE assertion changed shape on 2026-09-18** and is worth reading before
touching it. It used to pin loopback, both spellings; `remote.urls` is a
wildcard now and the boundary is `trust.rs` (above), so the same test pins the
wildcard AS WRITTEN plus the guard that replaced it — the two-origin predicate,
the recompute on navigation, the wrapper around `generate_handler!`, and
`open_main`'s refusal. A wildcard scope with nothing behind it is exactly the
failure that assertion exists to catch, and it is the one pin in that file § 15
was allowed to move.

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
base URL is the SPA's Networking page to show and to copy now (the Addresses card, since 2026-09-17), and no URL crossed
the IPC boundary from the page in either design. The
`opener:allow-reveal-item-in-dir` grant in `capabilities/wizard.json` covers
the plugin side; the app commands are gated by their own permission entries
here.

`main`'s page is served by the subshell-server this app manages, so it is
treated as remote content. Its `remote.urls` USED to be the gate — see "The
dashboard window's two trusted origins" below for what replaced it, and why.

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

**A FRESH machine gets no press and no form (2026-09-10; zero-touch per spec
2026-09-17 § 4).** Where no server exists and one is bundled, the page FIRES
the setup chain itself — the progress checklist is the first screen and it
opens the dashboard by itself when done — and the press survives only where
the fire is refused: the pre-filled form fallback and recovery's **Set Up**,
both of which run the same chain. The chain is `desktop_setup`, unchanged from
2026-09-10: install → init → service install → start, each step calling the
same extracted body (`install_server_now`, `init_now`, `service_now`) its own
command uses, stopping at the first failure so the ordinary probe names the
remainder. This reverses the rule above it, and the distinction is what makes
both true: the two-click floor protected the PREFILL, which comes from asking
the installed server for its settings — a machine with no server has nothing to
prefill, so the form was four clicks executing a plan `decide()` had already
made. Disclosure moved from the form to the checklist's hint, which names every
path the chain writes to. The chain also waits for the re-probe to say READY
before opening the dashboard: `service start` returns when the manager has
spawned the process, not when the port is bound, and every existing opener of
the window (the `ready` button, the tray) opens only against a server that
answers.

**The install offer mirrors a Rust list; the page never sends a command.**
Missing tmux gets `desktop_install_tmux` (brew where it exists, pkexec apt-get
on Linux — never a bare sudo, which has no tty from a GUI and hangs to the
timeout). The decision is pure TypeScript in `ui/src/lib/installers.ts`
(`tmuxInstallPlan`) and is MIRRORED in Rust by
`crates/desktop-core`'s `tmux::install_argv` (it lived in `control.rs` until
2026-09-18, when Subshell Client needed the same installer and the table moved
to the shared crate rather than being copied a third time),
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
`bridge.rs`, and since the menu bar that carries ACTIONS is macOS-only — the
Linux window bar added 2026-09-17 carries one PREDEFINED About item, which
muda's GTK backend answers in its own click handler and never routes an id —
`bridge` is gated at the MODULE — on Linux it is otherwise entirely dead
code.

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
| Menu bar | full `NSMenu` | one item: the predefined **About** on the dashboard window (spec 2026-09-17 § 6) — a GTK menu bar is per-window chrome, not a system bar, so it carries nothing else |
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
  thing on the tray could not be pressed. It is "Open Control Plane In App" now
  and always enabled, because `open_home` answers for both states of the machine
  — which also retired `set_server_ready` and the `DashboardItem` it held. A
  second in-app door, "Open Server App", sits beside it: it calls
  `windows::open_assistant` and raises the bundled window directly, no probe and
  no server question — the client tray's "Open Client App" carried to this side.
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

**One item is a near-exception, and it is worth stating rather than
discovering.** **Server Addresses…** (spec 2026-09-18 § 14) exists in the
window UI too — the recovery screen's link — but that screen renders only while
the server is not answering, and the case this item was added for is a server
that answers and refuses every sign-in. So on a Linux desktop with no
StatusNotifier host, and on that particular machine, the tray really is the
only route: the remaining doors are `subshell-server configure` at a terminal
and hand-editing config.env, which are the CLI acts this screen wraps. macOS
keeps the menu bar, where the item is not duplicated for a different reason —
the View menu's ⌘4 already reads "Server Settings" and points at the SPA, and
two items a word apart leading to two places would cost more than the
shortcut buys.

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
