# Design: First run, second pass — a Setup Assistant, from download to first subshell

Date: 2026-09-11
Status: proposed design, written from the operator's review of the shipped
first-run experience (PR #38, `2026-09-10-desktop-first-run-wizard-and-reset-design.md`)
and the direction "make it feel like setting up macOS".
This document supersedes § 5 of that spec (the six-step wizard) and revises
§ 7 of `2026-09-10-onboarding-to-first-subshell-design.md` (the SPA's Agent
step). Reset (§ 7 of the wizard spec), the `onboarded` flag (§ 4) and the
three-window model (§ 3) are unchanged.

Companion plan: `docs/superpowers/plans/2026-09-11-first-run-second-pass.md`.

## 1. What the operator saw, and what causes each

| Reported | Cause |
|---|---|
| The overall design feels rough, not polished | `ui/wizard.html` is a plain-DOM page in the console's idiom: an `h1`, a flex-wrapped list of step names in 12.5px text, one bordered card, a `<pre>`. No brand mark, no hierarchy, no motion, no empty or loading design. |
| The navigation sections look like links, not steps | `.rail` renders six words coloured by state. Nothing is numbered, nothing is a shape; done steps get a `✓ ` prefix, the current one is bold. That is a breadcrumb, and breadcrumbs are clickable by convention. |
| It did not detect that Claude Code was installed | The native Agents step **has no detection**. `Probe` (`control.rs`) carries `tmux` and `has_brew` and nothing about agents; `wizard.ts` renders Install for all five ids unconditionally and only remembers what THIS session installed (`agentInstalled`, a `Set` that starts empty). |
| The harness install/detection section looks awful | Two dense surfaces. Native: five rows of `name - blurb [Install]`. SPA (`routes/setup.tsx` step 2): six `HarnessRow` fieldsets, each with emoji, description, status word, "checked N min ago", a Switch, and for every not-found harness the whole `HarnessInstallHelp` block. On a clean machine that is five expanded install blocks stacked. |
| The console log pane should not be in the first-run experience | `#output-card` in `wizard.html` renders the chain's verbatim stdout/stderr as a `<pre>` under the card. |
| After creating the account I was asked for harness settings again | Both wizards have an agents step. Only the SPA's can answer it, because detection lives in the server. |
| Why native at all? Why not the server binary, detecting Tauri? | Three acts must precede any server page: install the binary, write config.env and the auth secret, register and start the service. Those are the sidecar's and cannot live in the SPA. Everything else the native wizard took on belongs after the server answers, where the SPA already knows it is inside the desktop shell (`lib/desktop.ts`, the User-Agent marker). |

## 2. The shape: one Setup Assistant across two processes

macOS Setup Assistant is a stepped flow, and it is the reference here because
of WHAT makes it feel good, not because it has steps: every screen fills the
window and asks exactly one thing; Back and Continue never move; screens
that have nothing to ask do not appear; the machine's own work is a progress
screen with nothing to press; and the whole thing reads as one program from
"Hello" to the desktop.

Subshell's first run is two programs — the Tauri app before the server
exists, the SPA after — and the design is that the person cannot tell. Both
render the same **assistant frame** (§ 3), in the same window geometry (§ 4),
with the same type, tokens, motion and button positions, and the second picks
up the progress dots where the first left off.

```
 Subshell Server (native)                         │  the SPA (/setup), same frame
 ─────────────────────────────────────────────────┼──────────────────────────────────────────
 1 Welcome                                        │  4 Create Your Account
 2 Install tmux            (only when missing)    │  5 Add an Agent              (optional)
 3 Set Up Your Server  →  Setting Up…  →  ready ──┼─→ 6 Start Your First Subshell  →  the pane
```

Six decisions, three of which can be skipped in one press, one of which
appears only when needed. Compared with today: the native Prerequisites,
Addresses, Agents and Done screens are gone as SCREENS; tmux is conditional,
addresses are a "Customize…" link, agents are the SPA's, and Done is the
dashboard opening by itself.

## 3. The assistant frame

One visual specification, two implementations (plain-DOM TypeScript in
`apps/server/desktop/ui`, React in `apps/server/web`). They share no code —
the native page has no React and the SPA has no reason to ship a second
build target — so the spec is what keeps them one thing, and the plan pins
the parts a test can see (button labels and positions, dot semantics,
`aria-current`).

### 3.1 Geometry

```
┌────────────────────────────────────────────────────────────┐ 1024 × 720
│                                                            │
│                        [ illustration 96 ]                 │  the column is centered in the region
│                                                            │
│                     Title, 30px / 600                      │  column: max-width 560px, centered
│          Subtitle, 15px muted, at most two lines           │
│                                                            │
│   ┌──────────────────────────────────────────────────┐     │  content: ONE decision, no card chrome,
│   │  the screen's content                            │     │  sits directly on the ground
│   └──────────────────────────────────────────────────┘     │
│                                                            │
├────────────────────────────────────────────────────────────┤  hairline
│  [ Back ]                 • • ● • • •            [ Continue ]│  bottom bar: 72px
└────────────────────────────────────────────────────────────┘
```

- **Ground:** `--background` (Dreamframe `#1d182a`). No card around the
  content; a screen is the window.
- **Column position:** centered in the region, not pinned below a fixed
  top margin — a two-line screen otherwise clusters against the top of a
  720px window and reads as unfinished. Centering is `safe`, so a screen
  taller than the region (the failed checklist with Show Details open)
  overflows downward into the scroll rather than past the unreachable top
  edge.
- **Illustration:** a 96px FLOOR rather than a 96px square, since the two
  art kinds have different aspect ratios. Welcome shows the full product
  **wordmark** at 64px height (`wordmark-96.png`, `wordmark-192.png` at 2x,
  generated by `bun run brand:generate` into each page's own asset root) —
  the `/s` mark alone names nothing to someone opening the app for the
  first time. Every other screen shows a monochrome glyph in `--primary`
  at 20%, 72px (terminal, server, key, robot, rocket — `lucide` in the
  SPA, inline SVG of the same five in the native page).
- **Title:** 30px, weight 600, tracking -0.01em, Title Case ("Create Your
  Account"), centered. **Subtitle:** 15px `--muted-foreground`, sentence
  case, max two lines, centered, 8px below.
- **Content:** starts 36px below the subtitle, max-width 560px, left-aligned
  inside the centered column. Forms are 360px wide, centered, one column.
- **Bottom bar:** 72px, hairline top border in `--border`, 32px side
  padding. **Back** left (ghost button, hidden on the first screen and
  during progress). **Dots** centered: 8px circles, 10px gap, done and
  current in `--primary` (current 10px), upcoming in `--border`; not
  interactive, `aria-hidden`, with an `sr-only` "Step N of M" beside them.
  **Continue** right (primary button, min-width 120px; its label changes
  per screen: Continue / Install / Set Up / Create Account / Start). A
  screen that can be skipped puts the skip as a second ghost button
  immediately LEFT of Continue ("Skip"), never as a text link under the
  content.
- **Keyboard:** Enter activates Continue when it is enabled and focus is
  not in a textarea; the first field of a form screen is autofocused;
  Escape does nothing.
- **Motion:** a screen change crossfades and slides 12px (220ms,
  ease-out). Checklist ticks draw in (160ms). Everything under
  `prefers-reduced-motion: no-preference`; reduced motion swaps to instant.
- **Window:** fixed 1024×720 on the native side (§ 4); the SPA's `/setup`
  fills the viewport at any size and centers the same column.

### 3.2 Voice

Titles are short verb phrases in Title Case. Subtitles say what will
happen or why, never how. Nothing on a screen names a file path except the
Set Up screen's list (which is the disclosure of what the press writes).
The CLI's own words appear only behind "Show Details" on a failure. On
macOS the copy says "this Mac"; elsewhere "this machine" (from
`probe.platform`; the SPA reads `desktopPlatform()`, and says "this
machine" in a browser).

## 4. Window geometry, and the handoff

- `open_wizard` builds the window at **1024×720, centered, not resizable**,
  titled "Set Up Subshell Server". 1024 is `MIN_WIDTH`, the dashboard's own
  floor, which is what makes the next point possible.
- `open_main`, when the `wizard` window exists at the moment the dashboard
  is created, takes the wizard's **outer position and inner size** for the
  new window instead of the 1280×860 default. The dashboard therefore
  appears exactly where the assistant was, at the same size, and the
  wizard closes under it (the existing "raising main closes the wizard"
  rule). The window-state plugin saves whatever the person does after.
- The native page's last act is a fade of its own content to a single line,
  "Opening your dashboard…", so the swap reads as one window changing
  screen rather than two windows trading places.
- The SPA's `/setup`, inside the desktop shell, renders its dots offset by
  the three native screens (six dots, three filled); in a browser it shows
  three. `isDesktop()` is the switch.

## 5. The native screens

**Verified 2026-09-11 (plan Task 0): server-side detection was never the
problem.** `detectBinaryWithOptions("claude", "CLAUDE_PATH", knownPaths)` run
against a stock service environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, no
`SHELL`, no `CLAUDE_PATH`) resolves `~/.local/bin/claude` on rung 3, the
`knownPaths`-against-`HOME` rung. The non-detection the operator saw was
entirely the native Agents step's, which carries no detection at all. No
`binary-lookup.ts` fix is needed.


Page: `wizard.html` + `ui/src/wizard.ts` (rewritten), decisions in
`ui/src/lib/wizard-state.ts` (rewritten). The `desktop_setup` chain, the
probe, the poll (1500ms) and the `onboarded` rule are unchanged.

### 5.1 Welcome

Illustration: the product wordmark. Title **Welcome to Subshell**. Subtitle *Subshell
runs agent sessions in terminal panes you can watch from any device. Let's
set up the server on this Mac.* No content block. Continue. No Back.

### 5.2 Install tmux — conditional

Appears only while `probe.tmux === null`; a machine with tmux goes from
Welcome straight to Set Up, and the second dot fills as done. Title
**Install tmux**. Subtitle *Every subshell runs in a tmux pane, so the server
needs it before it can start.* Content, by `prereqState(probe)`:

- `install`: one large button in the content block — **Install tmux** (brew
  or `pkexec apt-get`, the existing plan) — and below it, muted: *Your
  package manager may ask for your password.* While it runs, the button
  becomes a spinner row "Installing tmux…".
- `manual`: *This Mac has no Homebrew, so there is no button that can
  install tmux from here.* A code line with the MacPorts command and a
  "Read the tmux docs" ghost button.

Continue is disabled with *Waiting for tmux* until the poll sees it, then
the screen shows a filled check for 600ms ("tmux is installed") and
**advances on its own**. Back returns to Welcome.

### 5.3 Set Up Your Server

Illustration: server glyph. Title **Set Up Your Server**. Subtitle *Here's
what will happen on this Mac.* Content: three rows with glyphs, no card:

- *Install the server* — `~/.local/bin/subshell-server`
- *Start it in the background, and at every login*
- *Open your dashboard* — `http://localhost:3080` (follows the port field)

Under the rows, a text link **Customize port and addresses…** that expands
the four `CONFIG_FIELDS` inline (prefilled exactly as today; `config-form.ts`
is unchanged) with a "Use defaults" link to collapse and clear edits. For a
`no-bundled` build only, a second link **Choose an existing server…**.
Continue reads **Set Up**. Back returns to the previous shown screen.

### 5.4 Setting Up… — progress, then ready

Pressing Set Up replaces the content in place (no slide): Title **Setting Up
Subshell…**, subtitle *This takes a moment.* Content: the five-row checklist
(`setupRows`: tmux, Server, Configuration, Background service, Running),
rows ticking from probe facts as the chain runs; the first not-done row
shows a spinner. Back and Continue are hidden; the dots stay. When the
probe answers `ready` (after the existing two-probe settle), the content
fades to *Opening your dashboard…* and the page calls `ipc.openMain()`
once.

On failure: Title **Setup Couldn't Finish**, subtitle *Nothing else was
changed.* The first not-done row turns red and carries `failureLine(result)`
(the CLI's last non-empty stderr line). Under the list a collapsed **Show
Details** reveals the verbatim output. Bottom bar: **Open Status Page**
(ghost, left) and **Try Again** (primary, right). Try Again re-runs the
chain; the probe already names the remainder, so a half-run converges.

### 5.5 What the page no longer does

Install agents, show a rail, remember a step, render a log pane, offer a Done
screen. `firstOpenStep` is replaced by `screensFor(probe)` (which screens
exist for this machine) and the page always opens on the first of them: a
machine that is already `ready` is never shown the wizard by boot (R6), and
one that becomes ready while the page is open is handled by § 5.4's ready
path from whatever screen is showing.

## 6. The SPA screens (`/setup`)

`routes/setup.tsx` keeps its data flow (`register`, `launch`, `finish`,
`completeSetup`, the `launchedRef` guard) and drops the `Card`. A
`SetupAssistant` layout component renders the frame; each step supplies
title, subtitle, content, and the bottom bar's buttons.

### 6.1 Create Your Account

Illustration: key glyph. Title **Create Your Account**. Subtitle *This is
the admin account for your Subshell server.* Content: Name, Email, Password,
Confirm, 360px column, Name autofocused. Continue reads **Create Account**
(disabled until confirm matches, as now). No Back. Errors render under the
form in `--destructive`.

### 6.2 Add an Agent — optional

Illustration: robot glyph. Title **Add an Agent**. Subtitle *A plain
terminal is always available with nothing to install. Add an agent CLI now,
or later in Settings.* Content: one `AgentRow` per built-in
**agent** harness (`type === "agent-harness"`; the terminal is the
subtitle's sentence, not a row), 44px each, no card border between them
beyond a hairline:

```
🤖  Claude Code                              ● Detected · v1.2.3
◎   Codex                                    ○ Not found     [ Install ]   How to install ▾
```

- Status chip: `Detected · vX` in `--success`; `Not found` muted; `Check
  CLAUDE_PATH` in `--warning` for `override-invalid` (the variable name
  from the row's own `envOverride`, never derived).
- **Install** appears only where installing from here exists (§ 7); **How
  to install** expands the existing `HarnessInstallHelp` (command, docs,
  the override explanation) under the row, collapsed by default.
- No Switch, no description line, no timestamp. `installedHere` is plugin
  management, which lives in Settings → Plugins.
- The list re-probes itself every 4s while this screen is open
  (`useHarnesses({ refetchInterval })`), paused during an Install. No
  Re-check button anywhere.
- When nothing is detected: *Nothing on this machine? …or register a Node →*
  under the list.
- Bottom bar: Back is absent (an account cannot be un-created; the SPA has
  no previous screen), **Continue** right.

### 6.3 Start Your First Subshell

Illustration: rocket glyph. Title **Start Your First Subshell**. Subtitle
*Everything below is already filled in. Change anything you like.* Content:
`NewSubshellForm` with `firstRun` — three fields, and the two pickers lead
with a plain word and teach the product's noun underneath (**Machine**, *Where
this subshell runs. You can add other machines as nodes later.*; **Agent**,
*The agent CLI it launches, with its saved settings — a profile.*). "Node" and
"Profile" are the first jargon this product would otherwise say to someone who
has had an account for ninety seconds, and one of them is answered by a row
reading "Server", which makes the word look like a synonym for the one thing
the vocabulary says it is not. Every other launch surface keeps the nouns bare:
its reader already has the model.

**No name field, anywhere** (not only here): the server names a subshell after
its start time, the pane's own title takes over, and renaming is its own act on
a subshell that now exists — "Edit title" in its actions menu, which is also
the title pin. The clone dialog keeps its name box, because naming the copy is
the entire decision there. Bottom bar: **Skip** (ghost, left of Continue)
→ `finish()`; **Start** (primary) → `launch()`; while pending, *Starting…*.
Create errors render through `createSubshellErrorMessage` under the form.
Success navigates to `/subshells/$id` — the live pane is the last screen.

### 6.4 In a browser

The same frame at viewport size, three dots, "this machine" in copy. A
CLI-provisioned server's first visitor gets the assistant too.

## 7. Phase 3: the control plane installs an agent CLI (separately approvable)

Unchanged from the first draft of this design; restated for the record.

- `POST /api/setup/agents/:pluginId/install` in its own module
  (`api/setup-agent-install.route.ts`, the `settings-public.route.ts`
  precedent: split because its GATE differs). **Never public**, even in the
  no-users window — an unauthenticated caller making the host fetch and run
  a remote script is remote code execution whatever the URL allowlist says.
  Admin cookie only (`resolveSetupActor(request) === "admin"`); bearer keys
  403. The Agents screen runs after the Account screen, so the first person
  through already holds that cookie.
- Id must be in `builtInIds()`; the command is
  `getHarness(id).installHint.command` from the manifest compiled into this
  binary. Empty command (terminal) → 400. One install per id at a time →
  409. Response `200 { ok, exitCode, output, harness }` with `harness`
  re-probed after the installer exits; `ok:false` is a run that failed, 4xx a
  refusal before anything ran.
- Execution (`services/agent-install.service.ts`): `Bun.spawn(["sh","-c",cmd])`,
  `stdin: "ignore"`, `PATH` extended by `loginPathEntries()`, 10-minute
  timeout then kill, stdout+stderr each capped at 64 KiB with `[truncated]`.
  Audit `agent.install` with `{ ok, exitCode, durationMs }`, never the output.
- Security accounting (`docs/security.md` § 11.10): the script runs as the
  server's own OS user with exactly the reach the server's children already
  have, and it is the same command the desktop app ran as the same user
  from the user's session — a different parent process, no new capability.
  The id is the only input. A hardening pass would add an operator switch
  to disable the route (§ 12).
- Retires: `desktop_install_agent`, `AGENT_INSTALLS` (Rust and
  `installers.ts`), the agent half of
  `the_console_install_table_and_the_rust_one_agree`,
  `allow-desktop-install-agent`, and the console's "Install an agent CLI…"
  affordance at `ready` (replaced by "Add agents in the dashboard" →
  `openMain`).

If phase 3 is declined, § 6.2 ships with **How to install** only.

## 8. Contracts, complete

### 8.1 `wizard-state.ts` (desktop)

```ts
export type ScreenId = "welcome" | "tmux" | "setup";
/** Which screens exist for THIS machine, in order: tmux only while missing. */
export function screensFor(probe: Probe): ScreenId[];
/**
 * Dot semantics: always six positions, not three. The SPA's three `/setup`
 * screens (Account, Agent, Launch) always follow the three native ones on a
 * desktop first run, so a three-dot row would grow to six the moment the SPA
 * takes over — contradicting § 4's claim that the row's width never changes
 * at the handoff. Rendering six from the start keeps it constant throughout.
 */
export function dots(probe: Probe, current: ScreenId): { total: 6; done: number; current: number };

export type SetupRowId = "tmux" | "server" | "config" | "service" | "running";
export interface SetupRow { id: SetupRowId; label: string; detail: string; done: boolean }
export function setupRows(probe: Probe, addresses: { port: string; host: string }): SetupRow[];
export function canSetup(probe: Probe | null, busy: boolean): { ok: true } | { ok: false; reason: string };
export function failureLine(result: ActionResult): string;
export type PrereqState = "found" | "install" | "manual"; export function prereqState(probe: Probe): PrereqState; // unchanged
```

Deleted: `WizardStepId`, `STEP_ORDER`, `STEP_LABELS`, `firstOpenStep`,
`runRows`, `canContinue`.

### 8.2 Rust (desktop)

- `windows::open_wizard`: `.inner_size(1024.0, 720.0).resizable(false).center()`,
  title `"Set Up Subshell Server"`.
- `windows::open_main`: if `app.get_webview_window("wizard")` is `Some(w)`,
  read `w.outer_position()` and `w.inner_size()` and apply `.position()`
  and `.inner_size()` (scaled to logical units) to the builder instead of
  the 1280×860 default. Everything else unchanged.

### 8.3 Capabilities (desktop)

`wizard.json` grants: `core:default`, `dialog:allow-open`,
`allow-desktop-probe`, `allow-desktop-setup`, `allow-desktop-install-tmux`,
`allow-desktop-set-server-bin`, `allow-desktop-open-tmux-docs`,
`allow-desktop-open-main`, `allow-desktop-open-console`. Removed:
`allow-desktop-install-agent`.

### 8.4 Wire (server)

`HarnessInfoSchema` + `types/harness.ts`: `type: "agent-harness" | "terminal"`.
Phase 3: `POST /api/setup/agents/:pluginId/install` →
`200 { ok: boolean; exitCode: number | null; output: string; harness: HarnessInfo }`,
`400 | 401 | 403 | 409 ApiErrorResponse`, `operationId: installSetupAgent`.

### 8.5 SPA modules

- `components/setup/setup-assistant.tsx` —
  `SetupAssistant({ illustration, title, subtitle, dots: { total, done, current }, back?, skip?, primary: { label, onClick, disabled?, pending? }, children })`
- `components/setup/step-dots.tsx` — `StepDots({ total, done, current })`
- `components/setup/agent-row.tsx` — `AgentRow({ harness, onInstall?, installing? })`
- `hooks/use-harnesses.ts` — `useHarnesses(options?: { refetchInterval?: number })`
- phase 3: `hooks/use-install-agent.ts` — `useInstallAgent()`
- deleted: `components/harness-row.tsx`, its test, `hooks/use-harness-toggles.ts`
  (if `setup.tsx` was its last caller).

## 9. Testing

- **Desktop, pure:** `wizard-state.test.ts` for `screensFor` (tmux present →
  `["welcome","setup"]`; missing → all three), `dots` (skipped tmux counts
  as done; current index), `setupRows`, `canSetup`, `failureLine`,
  `prereqState`. `ipc-acl.test.ts` re-pins the wizard grant set.
- **Desktop, Rust:** `open_wizard`'s size and `resizable(false)` are not
  unit-testable through Tauri's builder; the plan verifies by running the
  app. Phase 3 removes the agent assertions in `control.rs`.
- **SPA:** `setup-assistant.test.tsx` (title, subtitle, Back hidden when
  absent, primary label and disabled state, skip present when given, Enter
  triggers primary), `step-dots.test.tsx` (count, `aria-current`, sr-only
  "Step N of M", no buttons or links), `agent-row.test.tsx` (chips, collapsed
  help, override name, Install only with a handler), `setup.test.tsx` updated
  for the new labels ("Create Account", "Start", "Skip"), the agents-only
  list, and the dots offset under a desktop UA.
- **Server:** the `type` assertion on `/api/setup/harnesses`; phase 3's
  service and route tests as listed in § 7.
- **e2e:** `01-setup-wizard.spec.ts`, `15-onboarding-clean-machine.spec.ts`
  updated: `Step 2 of 3` is now the sr-only text (assert via
  `getByText("Step 2 of 3")` still works, or via `[aria-current="step"]`);
  agent rows are `listitem`s named by the agent; "ready" → "Detected";
  Terminal is a sentence; buttons are "Create Account", "Continue", "Start",
  "Skip". The whole-flow claim of spec 15 is the acceptance test for phase 2.
- **By hand:** fresh macOS user, launch the `.app`: Welcome → (tmux) → Set Up
  → Setting Up → the dashboard appears in the same place and size showing
  Create Your Account with six dots, three filled.

## 10. Docs and release housekeeping

- `apps/server/desktop/AGENTS.md`: rewrite "The first-run wizard" as "The
  setup assistant" (screens, `screensFor`, the geometry handoff, no log
  pane); update the wizard row of the IPC table; note the fixed window size
  under "Windows".
- `README.md` lines 71–80: the first-run paragraph.
- `docs/superpowers/specs/2026-09-10-desktop-first-run-wizard-and-reset-design.md`:
  a status line pointing § 5 here.
- Changesets: `@internal/desktop-server` minor; `@internal/server` minor.
  Never `@internal/server-web`.
- Phase 3: `docs/security.md` § 11.10, `.claude/rules/security-context.md`.

## 11. Non-goals

- `apps/client/desktop`'s first run. Same shape, separate window model, its
  own pass — but it should adopt this frame when it gets one.
- Installing agents on remote nodes; third-party plugins' install commands.
- Moving the setup chain into the CLI. The first act copies the app's own
  sidecar into place, which no CLI can do before it exists.
- A light theme for the native page.
- Changing the account step's semantics, the auth posture, or `main`'s three
  commands.
- A shared component library between the native page and the SPA. The frame
  is a specification; two small implementations are cheaper than a third
  build target.

## 12. Decisions left to the operator

- **Phase 3** (server-side install): recommended yes.
- **Six dots in desktop, three in browser** (§ 4): recommended yes; it is
  what makes the two programs read as one.
- **Fixed, non-resizable native window** at 1024×720: recommended yes, the
  assistant idiom; the dashboard that replaces it is resizable as always.
