# Zero-Touch Desktop Setup & Visible Updates

**Date:** 2026-09-17
**Status:** approved design, pre-implementation
**Scope:** `apps/server/desktop` (assistant window, tray, updater surface) and
`apps/server/web` (the desktop-only sidebar row). The Subshell Client app is a
follow-up with the same machinery.
**Amends:** spec 2026-09-12 §5 (first-run screen set) and §7.2 (update
notification). **§14 is NOT amended** — "automatic updates are explicitly not
this design" survives verbatim; what changes is that an available update becomes
*visible*, never *applied*.

## 1. Problem

Four defects, all observed by opening the app on a machine with no server
installed (2026-09-17, live):

1. **First run asks for consent it never uses as a choice.** The wizard shows
   Welcome (announcing what will happen), tmux (Continue even when found),
   permissions (a TCC prompt deferred until notifications are actually wanted),
   and a Set Up screen whose button then does the only thing the screen is ever
   reached for. On the common path — nothing installed, defaults fine — the
   whole journey is one press on a foregone conclusion, and every extra press
   reads as friction before the product has done anything.
2. **An available app update is nearly invisible.** The daily launch check
   relabels the tray's "Check for Updates…" item (tray.rs:78-101) and nothing
   else. The dashboard — where a person actually lives — says nothing about the
   app that hosts it.
3. **The recovery screen carries an About block** (Terms / Copyright / Website
   / Licence / Publisher) inside Show Details, where it crowds the parts of
   Details that are doing repair work (tmux path, server-log tail, last
   action).
4. **The customize path (port, addresses, supervision) sits on the critical
   path** of every first run even though the dashboard's Service page already
   owns all three questions post-setup, with the same validation and the same
   restart semantics.

## 2. Decisions

| # | decision | what it replaces |
|---|---|---|
| D1 | First run **auto-provisions**: window open ⇒ the setup chain fires, progress is the first screen | Welcome / tmux-always / Set Up button |
| D2 | The **only unasked-to-third-party stop is tmux**: with tmux absent the flow pauses at the named tmux screen (Install with Homebrew / instructions). The server binary ships inside the app, so installing it unasked installs nothing foreign | tmux screen's "every first run" rule (2026-09-12) |
| D3 | The permissions screen leaves the journey; it stays reachable **on request** exactly as today (dashboard banner → `desktop-screen: permissions`) | macOS first-run permissions step |
| D4 | Updates are **shown, never applied** — detection automatic, application one deliberate click, restart is that click's own consequence | §14 stand; only its discoverability changes |
| D5 | Two notice surfaces: the **tray item**, whose label and destination change when an update is known, and a **sidebar row** in the user-panel footer (desktop-only; the tray is desktop by nature) | relabeled menu item alone |
| D6 | **About moves to the macOS app menu** (standard About panel); Details keeps only the app-version line | About block inside Show Details |
| D7 | Customization survives by **moving to the dashboard**, not by staying on the wizard path | Setup-screen form (kept only as the conflict fallback, § 4.3) |

## 3. Non-goals

- **No auto-apply, no at-quit install, no background download before the
  click.** (Decision recorded after review: "we should never force an update
  on a user"; the NetBird tray panel is the model — persistent, non-intrusive,
  user-clicks.)
- **No check of the installed *server CLI* against the release index** from
  the assistant. `decide()` still compares only bundled vs installed; the
  latest-release question remains with the SPA Service page
  (`services/releases.ts`) and `subshell-server update`.
- No snooze state in Rust — "Later" is per app run, in the page (§ 5.3).
- The Subshell Client app's updater treatment is a follow-up.

## 4. D1-D3: the zero-touch first run

### 4.1 New journey

`screensFor(probe, onboarded)` (wizard-state.ts) becomes:

```
probe.next === "ready"     → []                    (unchanged: dashboard opens)
!onboarded, tmux missing   → ["tmux"]              (the one stop, D2)
!onboarded                 → ["setup"]             (auto-fires, § 4.2)
onboarded, not ready       → ["recovery"]          (unchanged)
```

Welcome and the permissions step drop out of the first-run family. The dots
disappear from the first-run path: with one automatic screen there is no
journey to count. (This is also what retires the 2026-09-12 rationale for the
always-shown tmux screen — that rule existed to keep dot positions honest; the
dots are gone.)

### 4.2 Auto-fire

`render()` of the setup screen, once per window load, calls the existing
`startSetup()` instead of rendering the button first. Module-level
`autoFired` flag: one fire per load; a page reload after a crash re-fires, and
the chain is already idempotent (`already_installed` compares size + version,
`service install` no-ops when the unit exists), so a half-finished first run
resumes rather than duplicating.

The progress screen (`renderProgress` / `setupRows`) is unchanged and becomes
the first visible surface: it already names each act as it happens — which is
what Welcome promised and the deleted plan rows (§750 comment, wizard.ts)
promised before it.

Handoff: on ready, the app opens the dashboard directly (boot already does
this on a ready probe); the `ranSetupHere` Continue press is removed — the
handoff screen survives only as the "Opening Your Dashboard…" moment its ready
title already names.

### 4.3 When auto-fire must NOT happen

`canSetup` gates and the port-conflict check decide before firing:

- **tmux missing** → stop at the tmux screen (D2). With Homebrew the screen's
  one button installs; without, the manual instructions. This is the only
  third-party install in the product that a person sees coming.
- **port conflict / gate refusal** → render the existing setup form
  pre-filled, with the conflict warning above it (the current
  `portWarning` placement rationale stands). A machine that *cannot* take the
  default port is exactly the machine that needs the questions; auto-choosing
  a different port silently is refused on the "config written the user never
  saw" rule.
- **`serverChoice === "no-bundled"`** (dev builds with a stub sidecar, or a
  future asset gap) → the form, with "Choose an existing server…" as today.

Failure during the auto chain lands on the existing `renderFailure` — the
screen this design makes more reachable, not less; "Last action" inside
Details is why D6 keeps that part of Details.

### 4.4 Onboarding bookkeeping

Unchanged: `mark_onboarded` fires on the first ready probe, so a machine set
up entirely from the CLI still skips the assistant (R6 rule intact).

## 5. D4-D5: showing updates without ever applying one

### 5.1 What stays automatic

`check_on_launch` as today: at most once a day, backgrounded, opens nothing,
writes only `lastUpdateCheckAt` / `lastUpdateVersion` (app_update.rs). Nothing
downloads until the person clicks.

### 5.2 Tray

`build()` keeps one update item, but the label is no longer the whole notice:

- update known: **"Update available — Subshell Server {version}"**, and
  clicking it opens the assistant at the existing `app-update` screen (where
  install + restart live on the bundled page) instead of re-checking.
- none / unknown: "Check for Updates…" → runs the check as today (the item
  stays because a person may not want to wait for tomorrow's daily check).

`update_label()` stays the pure function it is; the branch on
`available.is_some()` is new and tested.

### 5.3 Sidebar row (desktop only)

A row in the sidebar footer, **above the `UserMenu`**, rendered only under
`isServerDesktop()`:

```
┌─────────────────────────────┐
│ Subshell Server 0.7.2       │
│ v0.8.0 available    [Update]│  × dismiss
└─────────────────────────────┘
```

- **Data:** a new **read-only** command `desktop_app_update` — no arguments,
  returns `{ currentVersion, availableVersion: string | null }` from the two
  settings fields the daily check already writes. It is granted to the
  `main` window as its **seventh** command, argued and pinned like
  `desktop_permissions` (2026-09-14 §7): no input, two facts already in the
  settings file, no CLI, no filesystem beyond the app's own settings.
  `ipc-acl.test.ts` gains the command + its (empty) argument list; its scope
  pins (`remote.urls`, `windows: ["main"]`, `local: false`) are unchanged;
  `docs/security.md` gains the accounting line, and security-context.md's
  "six commands" prose goes to seven.
- **[Update]** invokes the existing granted path: open the assistant at
  `app-update`. The row itself never installs.
- **Dismiss (×)** writes `sessionStorage` keyed by the version string: the row
  is gone for the app run, a newer version re-shows it, and quitting clears
  the dismissal — matching "they'll do it later" without inventing snooze
  state on the native side. The tray item is *not* dismissed away: it is a
  request surface, not a notification (nothing pops, nothing reopens).
- Nothing polls: the SPA invokes `desktop_app_update` once per page load, and
  the daily check at most changes the answer once a day; the tray is the
  live surface between loads.

### 5.4 The `app-update` screen

Gains the second button, **Later**, which closes the assistant (no state).
"Update now" keeps today's flow: download → minisign verify → install →
restart. The restart is the click's consequence; in app-supervision mode this
is a server restart, and the screen's existing body text already says who runs
the server — it gains one sentence saying so when `supervision === "app"` and
live panes exist. (Reuse the restart route's pane-safety framing, wording new.)

## 6. D6: About → the app menu

- macOS: app menu gains the predefined **About Subshell Server** item →
  standard panel, fed by `AboutMetadata` (version from `package.json`,
  copyright "Copyright 2026 Disaresta, LLC", website, and the licence line
  "AGPL-3.0-only (control plane), Apache-2.0 elsewhere"). Linux: same
  predefined item on the window menu bar.
- `detailsDisclosure()` loses the About group and the Website / Licence /
  Publisher links; keeps **one** fact from them — `This app — Subshell Server
  {version}` — because the version belongs beside the log text a person is
  about to paste into a bug report.
- Distinct from the SPA's `AboutDialog` (user menu → About), which is about
  the product and the server build; the native panel is about the app binary.
  Both remain, and the native one is the only one that knows the app version.

## 7. Testing

- `wizard-state.test.ts`: new `screensFor` matrix (tmux-conditional stop, no
  welcome/permissions/dots), plus a pure `autoSetupDecision(probe, conflict)`
  → `fire | form | stop-tmux` extracted so the § 4.3 branches are table-driven.
- Assistant: auto-fire fires exactly once per load (module flag) — pinned with
  a reload-after-failure case; no-fire when `autoSetupDecision` says form.
- `ipc-acl.test.ts`: `desktop_app_update` granted, zero-argument, scope pins
  unchanged; grant-equals-usage still holds (the SPA row invokes it).
- `update_label` branch test; tray-click routing (item available ⇒ open
  assistant screen, not re-check) at the Rust dispatch level.
- SPA: row renders only under `isServerDesktop()`; dismiss re-show semantics
  by version key (unit, following `desktop.test.ts` patterns).
- Existing suites extended, none replaced; `bun run test`, `verify-types`,
  `lint:check`, `lint:design` (the new row is token-only type), `rust:check`.

## 8. Failure handling

- Update check fails (offline, air-gapped): today's silence remains — an
  absent `availableVersion` renders "up to date" nowhere; nothing claims more
  than it knows.
- `desktop_app_update` before the first check ever: `{ currentVersion,
  availableVersion: null }` — the row shows the version line without the
  update button; not a defect, the tray's menu item remains the ask-early door.
- Auto-provision fails midway (service install refused, disk error): lands on
  `renderFailure` with the action's own output (the existing `failure`
  plumbing), Details expanded to the last action; the chain remains resumable
  per § 4.2.
