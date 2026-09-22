# Desktop Assistant Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the server desktop assistant to React/TSX (behavior preserved), then add the rail of options to both desktop apps' standing screens, with the first-time experience excluded from the rail.

**Architecture:** A shared `@internal/assistant` package (Frame now, Rail in wave 2); the server assistant's ~2900 lines of hand-DOM render become components consuming the existing pure `lib/` modules untouched; the 1500 ms poll becomes a `useServerState` hook. The IPC boundary does not move at all.

**Tech Stack:** React 19, Vite, Tailwind (v4, `@tailwindcss/vite`), bun test + happy-dom + React Testing Library (harness ported from `apps/client/desktop`).

**Spec:** `docs/superpowers/specs/2026-09-21-desktop-assistant-rails-design.md`

## Global Constraints

- **IPC is frozen.** No `desktop_*` command, event name, wire word, or enum member changes. `ui/src/lib/ipc.ts` is copied forward unchanged. The tests that pin it (`ipc-acl.test.ts`, `wire-names.test.ts`, `tauri-config.test.ts`) must pass unmodified except where a file they read moved.
- **Every port is a transcription.** Copy, buttons, refusals, latches, and sequencing come from the existing code, cited by function name and line range. A reworded label is a bug. The two-sentence/no-em-dash copy rule applies only to NEW strings.
- **Design system:** tokens only (`bun run lint:design` gates); type roles, never literal sizes.
- **The FTE never gets the rail** (operator ruling). In wave 1 there is no rail anywhere, which satisfies this trivially; wave 2 implements the exclusion.
- **Wave 1's definition of done:** the assistant behaves exactly as today (modulo the already-merged #130 fixes), rendered by React instead of hand-built DOM.
- Work in a dedicated worktree per wave; one PR per wave; gates before every push: `bun run verify-types && bun run lint:check && bun run lint:design`, the app's tests (`bun test src ui/src`, and `cd ui && bun test` where the harness lives — see Task 1), and full `bun run test` before the PR.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`; PR bodies end with the Claude Code attribution line.

## Reference map (the port's source of truth)

All citations are to `apps/server/desktop/ui/src/wizard.ts` at the wave's base commit unless named otherwise. The porting agent MUST read each cited function in full before porting it.

| Existing | Becomes |
| --- | --- |
| `renderWelcome` | `WelcomeScreen` |
| `renderTmux` | `TmuxScreen` |
| `renderSetup`, `renderProgress` | `SetupScreen` (renders progress while `running`) |
| `renderHandoff` | `HandoffScreen` |
| `renderRecovery` | `StatusScreen` (recovery half) |
| `renderHandoff` (ready half) | `StatusScreen` (ready half) |
| `renderUpdate` + `update-act.ts` consumers | `UpdateScreen` |
| `renderSupervision` | `SupervisionScreen` |
| `renderSettings` | `AddressesScreen` |
| `renderPermissions` | `PermissionsScreen` |
| `reset-view.ts` + `reset.rs` contract | `ResetScreen` (frame-replacing, no rail ever) |
| `detailsDisclosure`, `refreshTail` | `StatusDetails` (inside StatusScreen) |
| `pollSignature`/`pollShouldRender` gate | DELETED — React reconciliation replaces it (keep `pollShouldRender` deleted; its test file goes with it) |
| `applyScreen`, `go`, `render()`'s routing | `route()` pure function + host |

---

## Wave 1 — the package + the port, behavior preserved

### Task 1: Harness, React wiring, package scaffold

**Files:**
- Create: `packages/assistant/package.json`, `packages/assistant/src/index.ts`, `packages/assistant/src/frame.tsx`, `packages/assistant/src/__tests__/frame.test.tsx`
- Modify: `apps/server/desktop/package.json` (add `react` 19.2.8, `react-dom` 19.2.8, `@vitejs/plugin-react` 6.0.5, `@testing-library/dom` 10.4.1, `@testing-library/react` 16.3.3, devDeps pinned exactly; add `@internal/assistant` workspace dep)
- Modify: `apps/server/desktop/vite.config.ts` (add `react()` plugin from `@vitejs/plugin-react`, mirroring `apps/client/desktop/vite.config.ts`'s `plugins: [react(), tailwindcss()]`)
- Create: `apps/server/desktop/ui/bunfig.toml` + `apps/server/desktop/ui/test-setup.ts` (ported verbatim from `apps/client/desktop/ui/` of the same names)
- Modify: `apps/server/desktop/package.json` `test` script: split into `test` (bun test src) and `test:ui` (cd ui && bun test) and have root turbo run both — mirror how `apps/client/desktop` wires its two halves in `turbo.json`/`package.json`.

**Interfaces:**
- Produces: `@internal/assistant` exporting `Frame` and `AssistantStrings`:

```tsx
// packages/assistant/src/frame.tsx
export interface AssistantStrings {
  title: string;
  subtitle: string;
  problem: string;
}
export function Frame(props: {
  strings: AssistantStrings;          // title/subtitle/problem; empty strings hide
  art?: React.ReactNode;              // only Welcome renders art today
  children: React.ReactNode;          // the content region
  barLeft?: React.ReactNode;
  barRight?: React.ReactNode;
}): React.ReactElement;
```

- Consumes: nothing (leaf package, no internal deps, like `@internal/brand`).

- [ ] Step 1: Scaffold the package (name `@internal/assistant`, exports as above; SPDX `Apache-2.0` in package.json; `lint:licenses` must stay green — run `bun run lint:licenses`). Frame renders title (h1, `text-display`), subtitle, problem (warning color), content children, and the two bar slots, using the same Tailwind token classes the client's `Frame` (`apps/client/desktop/ui/src/components/assistant/frame.tsx`) uses — read it first and follow it.
- [ ] Step 2: Port the harness files verbatim (they need no edits: happy-dom + RTL + Base UI shims).
- [ ] Step 3: Add the React plugin + deps to the server app; `bun install`; confirm `bun run build` in the app still produces `ui/dist` and `verify-types` stays green.
- [ ] Step 4: Frame component test (renders title; hides empty subtitle/problem — same assertions the client's frame test makes, if one exists; else write three).
- [ ] Step 5: `bun run verify-types && bun run lint:check && bun run lint:design` from repo root; commit.

### Task 2: Host state, routing, poll hook

**Files:**
- Create: `apps/server/desktop/ui/src/host.tsx`, `apps/server/desktop/ui/src/lib/server-state.ts`, `apps/server/desktop/ui/src/lib/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `screensFor`, `isRequestedScreen`, `screenForRequest`, `recoveryTitle/Action`, `autoSetupDecision`, `handoffView`, `permissionsAfterSetup`, `RESET_LABEL` from `lib/wizard-state` (unchanged); `ipc` from `lib/ipc` (unchanged).
- Produces: the routing seam every later screen task consumes:

```ts
// lib/server-state.ts — the pure routing the old render() did inline.
// Ported from render()'s dispatch: wizard.ts render() lines ~2640-2752.
export type Route =
  | { kind: "welcome" } | { kind: "tmux" } | { kind: "setup" }
  | { kind: "handoff" } | { kind: "status" } | { kind: "update" }
  | { kind: "supervision" } | { kind: "addresses" }
  | { kind: "permissions" } | { kind: "reset" } | { kind: "boot" };
export function route(probe: Probe | null, screen: ScreenId | null, s: {
  running: boolean; failure: ActionResult | null;
}): Route;
```

Port the routing EXACTLY: reset view open → reset; probe null → boot; `isRequestedScreen(screen)` → that screen; list empty + running → setup-progress; list empty + `!handedOff` → handoff; else resolve/correct `screen` against `screensFor`'s list (the `list[0] === "welcome" ? list[1] : list[0]` correction included).

```ts
// lib/server-state.ts — the poll, testable.
export function nextPollDelay(s: { busy: boolean; running: boolean; hidden: boolean }): number | null;
// 1500 when a poll should run (busy&&!running → still runs, matching tick's
// `(busy || hidden) && !running` skip); null when it must not (busy, not
// running; or hidden, not running).
```

The host (`host.tsx`) owns ALL mutable state the old module vars held, in one
reducer-like object of `useState` hooks, ported value-for-value: `probe`,
`busy`, `running`, `screen`, `problem`, `lastResult`, `failure`, `lastTail`,
`detailsOpen`, `form`/`explicit`, `supervision`, `supervisionForm`,
`settingsForm`, `settingsBlind`, `settingsForceChecked`, `settingsResult`,
`seeded`, `updateState`, `updateProgress`, `appUpdate`, `updateSelection`,
`updateResult`, `resumeFired`, `installStartedAt`, `installLine`,
`tmuxResult`, `autoFired`, `continued`, `handedOff`, `opened`, `openFailed`,
`ranSetupHere`, `ranFirstRunHere`, `permissionsAfterHandoff`, `customizeOpen`,
`portCheck`, `portAsked`, `about` (read once on boot), and the reset step
events (`desktop-reset-step`; the reset view's own state moves into
**ResetScreen** in Task 7). (`settingsPending` named nothing in `wizard.ts`
and does not exist.) The host passes a `HostActions` object (the old
`AssistantHost` shape, plus `go` and the action runners) down as
props/context. The poll is `useEffect` + the `nextPollDelay` seam;
`checkPort`'s superseded-answer drop is preserved in a `usePortCheck` hook
(same cache keys `port`/`portAsked`) — currently inline in Host as
`_checkPort`; **Task 6 lifts it into the hook** when the address form, its
first consumer, lands.

**Six module vars are screen-local in the React model, NOT host state** (a
component that persists across re-renders no longer needs page-level state
to survive the poll's DOM teardown). Each names its home so no screen task
drops it:

- `tmuxOutputOpen`, `tmuxOutputScroll` (wizard.ts:165/177, written at
  561/655/666/672) → **TmuxScreen**;
- `manualRoute` (wizard.ts:193, 815–825) → **TmuxScreen**;
- `requestingNotifications` / `requestingPhotos` (wizard.ts:253–254,
  written at 1915/1939) → **PermissionsScreen**;
- `installClock` + `startInstallClock`/`stopInstallClock` (wizard.ts:505 —
  the 1 s repaint while `busy` holds the poll off) → the setup chain's
  **TmuxScreen** act (Task 3).

- [ ] Step 1: Write `route()` tests FIRST, ported from the routing's behavior: requested screen outranks; running holds the progress screen; the welcome correction; the handoff guard. Run, fail, implement, pass.
- [ ] Step 2: Implement `nextPollDelay` + its table test (busy holds off the poll except while `running`).
- [ ] Step 3: Implement `host.tsx` with the state inventory above (each var its own `useState`), the `ipc` calls in the same order the old module made them (boot probe → `desktop_pending_screen` pull → event listeners), and the poll effect.
- [ ] Step 4: `bun run verify-types`; commit.

### Task 3: FTE screens (Welcome, tmux, Setup/progress, Handoff)

**Files:**
- Create: `ui/src/screens/welcome-screen.tsx`, `tmux-screen.tsx`, `setup-screen.tsx`, `handoff-screen.tsx` (+ one `__tests__` file per screen)

Port 1:1 from `renderWelcome`, `renderTmux`, `renderSetup`+`renderProgress`+`checklist`, `renderHandoff`. Every string, button label, disabled condition, and the zero-touch auto-fire (`startSetup` chain in a `useEffect` gated by `autoSetupDecision`/`canSetup`/`autoFired`, fired via microtask after render exactly as `afterRender` did) is transcribed from the source functions. The checklist component ports from `checklist()` with the same rows/glyphs/spinner classes. Component tests: each screen's headline, primary action, gated/disabled reasons; the setup screen's auto-fire decision consumes `autoSetupDecision` (already pure-tested — assert the component calls it with the same inputs). Commit.

### Task 4: Status (recovery + ready + Show Details)

**Files:**
- Create: `ui/src/screens/status-screen.tsx`, `ui/src/screens/status-details.tsx`, `ui/src/screens/copy-button.tsx`

Port `renderRecovery` (including the `.recovery-links` stack from #130, the tmux warning factory → a keyed component, and `portWarning`'s trimmed copy), the ready half of `renderHandoff` (both `openFailed` and normal arms), and `detailsDisclosure`+`refreshTail` (tail pulled on open and while open — via the poll effect's details branch). The Copy affordance ports from `assistant/copy-button.ts` + `lib/copy-flash.ts`: the flash is React state keyed by the copy key (the element-lifetime problem that forced `copy-flash` out of the DOM is gone, but keep the keyed-by-string API so call sites read the same). The reset deep-link button in the bar (`RESET_LABEL…` → `openReset`) ports as-is. Tests: every recovery variant's title/action (drive via the pure `recoveryTitle`/`recoveryAction` + a probe table), the links stack presence, details open/pull, the Copy flash. Commit.

### Task 5: Update screen (both phases)

**Files:**
- Create: `ui/src/screens/update-screen.tsx`, `ui/src/screens/update-phase2.tsx`

Port `renderUpdate`, `runUpdateCheck` (entry-effect, `updateState` machine), `startAppUpdate`, `finishUpdate`, the selection table (`update-act.ts` consumers), the Force box (`pane-force.ts`), and the phase-2 screen's Try Again. The progress listener (`desktop-app-update-progress`) feeds `updateProgress` state. Tests: phases render (idle/checking/available/downloading), each §6 refusal sentence renders, the selection defaults, force box fail-closed. Commit.

### Task 6: Supervision + Addresses

**Files:**
- Create: `ui/src/screens/supervision-screen.tsx`, `ui/src/screens/addresses-screen.tsx`

Port `renderSupervision` (choice rows, login checkbox, `applySupervisionChoice`, the unchanged-gate on Apply) and `renderSettings` (the address form via the existing `addressForm` port → a controlled React form consuming `config-form.ts`'s pure seams, the https note toggled in place, `checkPort` → `usePortCheck`, the blind warning, the Force box, `runSettings`). Tests: both screens' controls, the https note toggle, the Apply gate. Commit.

### Task 7: Reset + Permissions

**Files:**
- Create: `ui/src/screens/reset-screen.tsx`, `ui/src/screens/permissions-screen.tsx`

Port `reset-view.ts` (frame-replacing; the hostname gate, the `desktop-reset-step` meter, the half-run log) and `renderPermissions` (rows from `permissions-model.ts`, allow/open-system-settings handlers, Back vs Continue by `permissionsAfterHandoff`). The `desktop-reset-step` listener feeds reset state. Tests: reset's refusal gate, the step meter round-trip; permissions' row actions per state. **Keep `applyScreen("reset")`'s screen-set PAIRED with the view's own `open()`** (the old `openReset` did both: the screen shows whether or not a plan staged, because the screen is what explains a refusal), and **gate the reset route on the view's open state, not on `screen === "reset"` alone** — the old routing went blank when the two disagreed, and that blanking was the defence in depth behind `open()` showing before it arms. **Re-check the reset route's epoch bump when the view's entrance lands**: the old `openReset` did NOT replay the entrance animation, but the host's screen-set bumps the epoch (both the Reset press and `applyScreen("reset")`); if the view wants the old no-replay, gate that bump or let the view's own mount own its entrance. Commit.

### Task 8: Entry wiring, deletion, gates, PR

- [ ] Step 1: `main.tsx` (new) renders `<Host/>`; `wizard.ts` and everything under `assistant/` that only served the DOM renders is DELETED; `styles.css` keeps tokens + classes the new screens still use (`.checklist`, `.facts`, `.pane-pre`, …) and drops the rest. `wizard.html`'s script entry changes to `/src/main.tsx`. Keep the CSP contract: module script, no inline (`tauri-config.test.ts` pins this — it must pass).
- [ ] Step 2: Full gates: `bun run verify-types`, `bun run lint:check`, `bun run lint:design`, `bun test src` + `cd ui && bun test`, full `bun run test`, and `bun run rust:check` is NOT needed (no Rust change) but confirm the app still `bun run build`s.
- [ ] Step 3: Manual browser verification with the mocked bridge (the reviewer scenario: recovery links navigate; setup port-conflict warning appears after blur) — same as PR #130's verification.
- [ ] Step 4: Changeset (`@internal/desktop-server`, patch: "The assistant is rebuilt in React..."), push, PR. Reviewer agent before merge.

---

## Wave 2 — the rail, server app

> **Operator ruling, 2026-09-22:** the Status section renders the facts and
> log tail INLINE — what was the Show Details disclosure becomes part of the
> section's content. Wave 1 ships the disclosure as today's transcription;
> wave 2 folds it into the Status section and moves its tests.

### Task 9: Rail in the package

**Files:**
- Modify: `packages/assistant/src/rail.tsx`, `packages/assistant/src/index.ts`, `packages/assistant/src/__tests__/rail.test.tsx`

```tsx
export interface RailSection { id: string; label: string; }
export function Rail(props: {
  sections: RailSection[];
  active: string | null;        // null renders no active state
  onSelect: (id: string) => void;
}): React.ReactElement;
```

Keyboard accessible (`role="navigation"`, buttons per section, `aria-current`). Test: renders sections, active state, select callback. Commit.

### Task 10: Rail wiring, server app (the FTE exclusion)

**Files:**
- Modify: `ui/src/host.tsx`, `ui/src/screens/*` (layout shells only), `ui/src/lib/server-state.ts`

- [ ] Step 1: The exclusion rule, as data: export from `lib/server-state.ts`:

```ts
export function railFor(r: Route, onboarded: boolean): RailSection[] | null;
// null  → full-window screen (route is FTE family, reset, permissions, or boot)
// else  → the standing sections, with the active one marked:
//   Status | Update | How it runs | Addresses  (ids: status|update|supervision|settings)
```

Pin by test: every FTE route → null; reset/permissions → null; standing routes → the five sections (Reset joined by the operator's 2026-09-22 ruling) with the right active id; a machine mid-first-run (probe says journey) → null even when a requested screen was never named.

- [ ] Step 2: Host renders `<Frame><Rail/><content/></Frame>` when `railFor` answers a list, full-window `<Frame>` otherwise. `go(section)` on select; a requested `desktop-screen` event lands on its section; `reset`/`permissions` still replace full-window.
- [ ] Step 3: Window: the rail lives in the same 1024x720 frame (rail ~200px column inside Frame). Verify at the zoom ladder's edges (`desktop-core`'s zoom floor) — no horizontal scroll, content ≥360px.
- [ ] Step 4: Component tests: rail visible on status/update/supervision/addresses; ABSENT on welcome/setup/progress/handoff/reset/permissions/boot; section select routes. Gates + changeset (`@internal/desktop-server`, minor) + PR. Docs: rewrite the assistant sections of `apps/server/desktop/AGENTS.md` to the new shape (the rail rule, the FTE exclusion verbatim).

---

## Wave 3 — the rail, client app

### Task 11: Rail on the client's standing screens

**Files:**
- Modify: `apps/client/desktop/ui/src/app.tsx`, `ui/src/lib/client-flow.ts`, `ui/src/lib/__tests__/client-flow.test.ts` (or node-assistant-state module — wherever `NodeUserScreen` lives)

- [ ] Step 1: `railFor` seam for the client, same shape: Status/Update/About sections; FTE walk steps and reset → null. Pin by test.
- [ ] Step 2: `App` composes `Rail` from `@internal/assistant`; the tray's `desktop-screen` events (`about`, `update`) select their section (the existing override state becomes the rail's active id — same semantics, no new command). Two wave-2 rulings carry over (operator, 2026-09-22): the client rail is Status/Update/About PLUS **Reset** as its fifth, destructive-styled section — the reset door in the rail, the reset screen still frame-replacing — and the leave buttons render only where the rail does not, for the same reasons. Two follow-up rulings the same day split the client's status screen: **Service** (the node's install offer, the service verbs, the pane-safety rewrite, the node's reveals; its subtitle carries the "what is a node" half the install explainer dropped) and **Control Plane** (the configured address, the way to change it, "Open in browser instead", the node's repoint machinery) join the standing set; the status screen's node-update doors are deleted (the Update section is the door) and its facts render inline. A later ruling batch the same day (screenshots 52/53): the not-a-node sentence is deleted; the `no-node` badge reads "Not registered as a node"; the `bundled` and `tmux` fact rows render only on Service; the Control Plane address row becomes the addresses-card form shape (labeled value row, acts grouped below); the plane's doors rearrange, and Re-enroll… moves to Control Plane. Two addenda the same day supersede part of that: the install explainer is deleted and the button reads "Install the Subshell Node CLI"; Control Plane becomes the LANDING and reads first in the rail (every rail select is an override, Status included), the status screen carries no door at all, and Control Plane's Dashboard card carries both doors ("Open in browser" system, "Open in app" in-app). The client app's `styles.css` must carry the rail's two nav-gradient tokens — `--nav-active-from` / `--nav-active-to`, value for value with `apps/server/web/src/styles.css`'s — the way the server app already does (wave 2); without them the shared `Rail`'s active gradient renders nothing.
- [ ] Step 3: The FTE screens (`ChoiceScreen`, `EnrollScreen`, `ConnectScreen`, `RegisterScreen`, `ProgressScreen`, `TmuxScreen`, `WelcomeScreen`) render full-window as today — assert the rail is absent in their component tests.
- [ ] Step 4: Gates (`bun test` in the app covers both halves via turbo), changeset (`@internal/desktop-client`, minor), PR. Docs: `apps/client/desktop/AGENTS.md` assistant section rewritten.
