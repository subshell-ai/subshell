# The assistant

Deep dive on the `wizard` page's screens, routing and log panes, plus the
deleted console's history, why `main` can never load a bundled SPA, and the
launch-preference and boot-resume window rules: the "The assistant" and
"The log, and the last action's words" sections and those paragraphs, lifted
verbatim from `apps/server/desktop/AGENTS.md`. Read this before working on
anything under `ui/src/screens/` or the screen-routing rules.

## The console that was, and where its halves went

**There was a third window until 2026-09-12.** The `console` was a bundled
page of five sections behind a sidebar (Overview, Logs, Addresses,
Application, About), and it was the surface a machine returned to once
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
session cookie to any of them, and admin routes reject bearer keys by design,
so serving the SPA ourselves would mean an auth rework, not a build change.

## The launch preference and the boot resume

**The launch preference moves that ready arm, and only that arm** (operator
ruling 2026-09-23). `settings.json`'s `openOnLaunch` is `dashboard` (the default,
and what every file written before it means) or `assistant`. A machine that is
NOT ready has no dashboard to open, so it comes up on the assistant whichever
way the preference is set; the preference answers the question "which of two
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
(spec 2026-09-18 § 4.2). It has to outrank (a machine whose server is running
answers `Main`, which would open the dashboard over an act the person started
and never show the screen finishing it), and it costs that machine nothing,
because dismissing the screen hands off to the dashboard anyway, through the
page's ordinary ready path.

## The assistant

One fixed frame, one screen at a time. `screensFor(probe, onboarded)` decides
the family (pure and tested without a webview in `ui/src/lib/wizard-state.ts`).
The dot row is gone (spec 2026-09-17): with one automatic screen there is no
journey to count, and the row that counted screens the person never saw was
the defect the removal closed.

**The rail is for the standing screens, and only for an onboarded machine**
(wave 2; the operator's ruling: "i do not want a sidebar applied to the FTE").
`railFor(route, onboarded)` in `lib/server-state.ts` is the rule as data: the
five sections (**Status**, **Update**, **Service**, **Addresses**,
**Reset**) appear only when the machine is onboarded and the route is one of
the standing kinds, and they answer `null` for the FTE family (welcome, tmux,
setup, handoff), for the permissions screen, for boot, and for ANY standing
route on a machine mid-first-run. Reset is the
fifth section and the DESTRUCTIVE one (operator ruling 2026-09-22, live
screenshot): the DOOR moves into the rail (`onSelect("reset")` is
`openReset`, the paired open-and-arm: it sets NO route, and the dialog renders
outside the routed frame), styled in the destructive
token. The same day's LAYOUT ruling put the reset
CONFIRMATION on the standing section itself (rail-highlighted, the sidebar
present); the 2026-09-23 wave superseded that, mirroring the now-proven
client: `onSelect("reset")` opens a centered **DIALOG** over whatever section
is up, so host.tsx's `data-route` keeps the section's kind and the Reset rail
highlight while the confirmation sits on top, overriding nothing. This
removed the last frame-replacing screen. The dialog is MODAL (a fixed overlay
across the window, positioned by class because the CSP has no
`unsafe-inline`), so it covers the rail and no navigation is reachable beside
it; the safety property that used to live in "withhold the rail while running"
now lives in the dialog being **inert to its own dismissal**: while `busy ||
running` Escape and the backdrop route through an `onClose` the dialog makes a
no-op, and the Cancel button is `disabled`, so nothing dismisses a chain that
is deleting this server. A half-run keeps the dialog open with its step log and a **Retry
reset**; a success closes it and returns to the standing journey. A
deep-linked reset arms the dialog show-first, and the handoff auto-open is
guarded so a ready machine cannot bury its own confirmation under the
dashboard. With the sidebar
present the rail is also the navigation: the
standing screens' own leave buttons (Back on Service, Back on
Addresses, Close on Update) render only where the rail does not: a
requested screen over a mid-first-run machine has none, and there the leave
button is still the only way out. That last case is the
old page's allowance (a requested update could render over a first run), and
wave 2 keeps the render but takes away the rail: the exclusion is about the
machine's journey, not about who asked. The rail is the shared
`@internal/assistant` `Rail` primitive, and its look is the SPA sidebar's,
down to the nav-gradient tokens (`--nav-active-*`) this app's stylesheet
carries value for value with the web app's.

**First run is zero-touch** (spec 2026-09-17 § 4): the page FIRES the setup
chain itself: the progress checklist is the first screen. It does NOT open the
dashboard by itself when the chain that ran HERE finishes: a pane that
navigates away at the moment it turns into an answer is jarring whichever way
the run arrived, so the completed checklist holds under *Subshell Server Is
Ready* until the person presses **Continue** (operator report, 2026-09-17,
restoring what § 4.2 had deleted the same day: `handoffView` carries both
rulings). A run this window did NOT start still hands off by itself: reopening
over a running server, or a recovery Start, has no result owed to a reader.
`ranSetupHere` is page state because the `ready` probe cannot say it: the
probe flags `onboarded` on the very read that reaches the handoff, so the flag
that gates the press has to be remembered by the window that ran the chain.
**On a Mac's first run that press hands off to the permissions screen rather
than to the dashboard** (operator's call 2026-09-18, spec § 10, the reversal
of D3), and that screen's own Continue does what this one used to.
`permissionsAfterSetup` is the pure fork and takes three facts: darwin,
`ranSetupHere`, and `ranFirstRunHere`, captured in `startSetup` BEFORE the
chain, because by handoff time every machine looks onboarded, and without it a
recovery Set Up would re-explain macOS to a machine that has seen all of it.
The one ACT before it is Install tmux, shown ONLY while
tmux is missing (the old always-shown rule existed to keep the dots honest;
the dots are gone); the poll seeing tmux re-resolves PAST the intro to the
chain and it fires. **A failed install is a state that screen renders**
(spec § 11): `tmuxInstallFailure` forks on the result AND on whether tmux
turned up, so an install that exits zero and changes nothing is reported as
loudly as one that exits non-zero; that case used to be indistinguishable
from a button nobody had pressed. The card carries the app's own headline, the
manager's last word, and both streams behind Show output; the button relabels
to **Try again**, which re-probes before it spawns anything, and the one line a
person can paste appears under it. **Welcome leads the first run again** (operator's call
2026-09-18, one day after D1 deleted it: "reset / initial state should always
show it again"; the probe-derived list restarts on its own, and a completed
reset re-arms the fired-this-load latch through `host.rearmFirstRun`; a
cancelled one does not, and the pins in `wizard-state.test.ts` hold both
halves). The intro is inert by construction: the auto-fire lives in
`renderSetup`, which Welcome does not render, so nothing touches the machine
until the press. Permissions are back, AFTER the chain rather than before it
(apps/server/desktop/docs/macos-permissions.md). A port conflict, a
busy gate, or a no-bundled build lands on the pre-filled form instead of
failing a chain nobody pressed: `autoSetupDecision` is the pure fork,
`canSetup` the one refusal predicate, and the page holds fire until the port
is MEASURED. `setupRows`/`failureLine` hold the checklist and the failure
line. Agents are not asked about here; the SPA's `/setup` owns that question,
because detection lives in the server.

**Recovery** is ONE screen, where the console was five sections. The title IS
the diagnosis (*No Server Found*, *Your Server Isn't Responding*, *Your Server
Needs Its Configuration*, *Your Server Isn't Installed as a Service*, *Your
Server Is Stopped*), and there is one primary action under it rather than a row
of three the reader has to choose between. `recoveryTitle` and `recoveryAction`
own both, and `lib/recovery-model.ts` owns the subtitle and the facts. The
pre-boot facts (binary and its rung, config file, service definition, manager
state and detail, log location), the server's own log tail, the last action's
verbatim output, and what this app itself is render INLINE under the diagnosis
(operator's ruling, 2026-09-22, wave 2: what was the Show Details disclosure
is part of the Status section, not a disclosure: a sidebar section that hides
its own facts behind a second control is two navigations for one answer), and
the log tail is pulled while the Status section is up, not while it is not;
the open-disclosure rule carried over under a new name. A standing Status on
a READY machine is this screen, with one primary **Open control plane** action
(the 2026-09-23 wave): it no longer routes to the handoff and auto-opens, so
selecting Status to LOOK at the server never bounces the window into the
dashboard. Only ARRIVAL (a window opened with no screen chosen) hands off and
auto-opens; the old `held`-handoff arm and `selectHeldHandoff` are gone. On a
NOT-ready machine the same rail item shows this screen in its diagnosis role,
exactly as before.
The other three doors the old screen stacked under its diagnosis (**Update
Subshell Server**, **How Your Server Runs**, **Server Addresses**) are the
rail's sections now, which is what those links existed to be a stand-in
for, and Reset is a rail section too (operator ruling 2026-09-22): the
door is the sidebar's destructive item, and selecting it opens the
confirmation DIALOG over the standing section (the 2026-09-23 wave; see the
Reset paragraph above), not under the rail as the same day's earlier layout
ruling had it.

**A requested screen is routed off `REQUESTED_SCREENS`, never a literal.**
`screenForRequest` (in `lib/wizard-state.ts`) maps the payload, and the reason
it is a function rather than a ternary at the call site is that the ternary
was wrong three times: `reset` was dropped when it was added, and
`supervision` when IT was added (each time raising the assistant onto a
screen it did not recognise, which then bounced the user back to the dashboard
they had just pressed a button on). Adding a screen means the Rust enum and
that list; there is no third place to forget.

**ONE screen says "update", and it does both halves** (spec 2026-09-18).
There were two (*Update Your Server*, which installed the bundled
`subshell-server`, and *Update Subshell Server* (`app-update`), which replaced
the `.app` or the `.deb` and relaunched), and they were never two acts. Every
desktop bundle SHIPS the CLI it wraps, so the second CONTAINED the first: a
person who updated the app met, on the next boot, a probe finding a bundled
server newer than the installed one, and was asked again. The names differed by
a possessive. `Screen::AppUpdate` and the word `app-update` are **deleted, not
aliased**; this product has no installed base to keep compatible, so a caller
still sending that word falls to `Home` where it can be seen. See
apps/server/desktop/docs/updating.md.

**Update Subshell Server**, **Reset**, **How Your Server Runs**, **What macOS Will Ask** and **Server Addresses** are never in `screensFor`'s list. They are
entered by REQUEST: a `desktop-screen` event (a LIVE window), the `desktop_pending_screen` pull (a window still coming up, which is also how the BOOT resume routes), carrying a member of the closed
`reset::Screen` enum (`home` | `reset` | `update` | `supervision` | `permissions` | `settings`; `home` parses to "whatever the probe implies"). That is what lets one
appear over a first run as readily as over a recovery without either family
naming them. A requested screen outranks the ready handoff in `render()`, or
the SPA's Update deep link would bounce the window straight back to the
dashboard it was asked to leave, and, since 2026-09-18, a machine that came up
to finish an update would open the dashboard over it and never show the
screen at all.

**Server Addresses** is the newest of them (spec 2026-09-18 § 14), and the
only one the dashboard never names, because the machine it exists for is one
whose dashboard cannot be REACHED, and these four values are otherwise
editable only from that page. The assistant is the way out structurally rather
than conveniently: it is the BUNDLED page, it drives the CLI rather than the
API, and it therefore needs no session. Read the app's own rule in the other
direction: *if the act is what makes the server unreachable TO YOU, the page
the server serves cannot be where you undo it.*

**The case it was BUILT for is fixed, and the fix is worth reading before the
screen** (operator's report, 2026-09-19). Saving an `https://` base URL used to
sign this app's window out for good: better-auth marks the session cookie
`Secure` for an https `APP_BASE_URL` (measured, 1.7.1) and the window only ever
opened on `http://127.0.0.1:<port>`, which cannot keep such a cookie. § 15 had
taught `trust.rs` to trust the configured address and let the window FOLLOW a
sign-in there, but nothing ever POINTED it there, so an operator who set an
https address got a dashboard that explained why it would not sign in and could
do nothing about it. The trust half was necessary and was not sufficient.
`Probe::window_origin` is the other half: the window opens on the configured
address when that address is https, and on loopback in every other case. What
the person sees is a restart and a fresh sign-in on the new origin, which is
what the card now says.

What is left for this screen is the case with no other answer: an address the
operator configured and this machine CANNOT reach (a tunnel that is down,
split-horizon DNS, a typo), where the window lands on a browser error and the
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
  "a background service, armed for login" (today's first-run chain), so a save
  that omitted it would install a service on a machine deliberately left in app
  mode, as a side effect of editing a port. What the chain still does beyond
  writing config.env is install the bundled server where it is newer than the
  installed one; that is the update screen's own act rather than a new one, and
  it is stated at `settingsPayload`.
- **The https sentence is the DASHBOARD's, verbatim**:
  `apps/server/web/src/components/networking/addresses-card.tsx` renders it at
  the same field, and `settings-screen.test.ts` reads that file and pins the two
  equal. Someone who lands here has already met the consequence; two wordings
  would read as two problems.
- **The Force box is the update act's box**, moved to `lib/pane-force.ts` when
  the second screen needed it: same sentence, same fail-closed `paneRisk`, same
  unticked default. This restart IS that restart.

Its door is the RAIL (**Addresses**, the section this screen selects). That is
the whole route now: the recovery screen's old stacked links to it became rail
sections in wave 2, and the tray item was removed in 2026-09-22, so a single rail
section is the one way in. It lives inside the assistant, which needs no session
because it drives the CLI, so the screen shows with the server down, stopped, or
running and refusing every sign-in. Not the dashboard, which is the point: the
machine it exists for is one whose dashboard cannot be REACHED. **Server Addresses** is the screen's own title
(`SETTINGS_LABEL` in `lib/settings-screen.ts`), deliberately NOT "Server
Settings", which is the View menu's ⌘4 into the SPA's settings routes, the pages
that need the session this screen exists to get back.

**Show Details keeps its openness in PAGE state**, not the element's.
`#content` is rebuilt on every render and the poll renders every 1500 ms, so a
`<details>` whose state lived only in the DOM collapsed under the reader twice
a second. The failure screen had exactly that defect from the day it shipped.

The window is **1024x720, fixed and not resizable**, and `open_main` takes its
position and size when the dashboard is created, so the swap reads as one
window changing screen. The SPA's `/setup` no longer continues a native dot
row when it sees the desktop UA marker: there is no native row to continue
(spec 2026-09-17); its row counts its own steps on every shell.

## The log, and the last action's words

The console's Logs section was one region with two tabs, a caption and a
selection that had to survive navigation. None of that survives it: the
assistant shows one screen at a time, and both panes render INLINE in the
Status section, one under the other; wave 2 removed the Show Details
disclosure that used to hold them, because a sidebar section that hides its
own facts behind a second control is two navigations for one answer. A tab
strip over two panes inside a 560px column is chrome for its own sake.

What DID survive is the behaviour that was load-bearing. The tail **sticks to
the bottom only when it is already there**: re-tailing while someone has
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
JSON-lines file first, on every platform (`status --json`'s
`paths.serverLog`, the same file the SPA's Service page shows, so the two
surfaces cannot describe different logs), and falls back to the service
manager's log only when that field is absent (a server older than it) or the
file has nothing in it yet. The fallback platforms differ in MECHANISM, not
just in path: Linux has no file at all, so it is a `journalctl` query against
the user unit, while macOS has the file the plist names and the CLI stays the
authority on where. It never returns an `Err`: no service yet, no entries
yet, and a file launchd has not created are the ordinary states of a machine
mid-setup.

**The tail is pulled only while the disclosure is open.** A CLI spawn every
1500 ms for a collapsed `<details>` is the cost with none of the benefit,
which is the rule the console's poll kept about its own hidden window.

The page **re-probes every 1500 ms** (`POLL_MS`), so there is no Refresh
button: the manager's whole subject is state this app does not own, and a
button could only ever save the remainder of one interval while implying the
rest of the screen might be stale. The poll skips while an action is in
flight, while the window is hidden, and while a hand is in an input: the
address form and the reset screen's confirmation box are both places a redraw
would throw away what was typed.
