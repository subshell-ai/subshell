# Design: The server console, organized — a sidebar, four sections, one hero

Date: 2026-09-11
Status: approved design (the operator chose the sidebar shape from three
options on 2026-09-11), written for an implementing agent to follow.
This document revises the CONSOLE page of the Subshell Server desktop app
(`apps/server/desktop/ui/index.html` + `ui/src/main.ts`). The setup
assistant (`2026-09-11-first-run-second-pass-design.md`), the reset chain
(`2026-09-11-native-reset-both-desktop-apps-design.md`) and the
three-window model (`2026-09-10-desktop-first-run-wizard-and-reset-design.md`
§ 3) are unchanged. Where this document names a behaviour as "unchanged", the
implementer keeps the existing code and its comments rather than rewriting
either.

## 1. What the operator saw, and what causes each

The console is the window a machine returns to once setup is done. The
operator's word for it was "cluttered", and the request was to apply the
same sense of design and navigation the setup assistant got.

| Seen | Cause |
|---|---|
| Everything at once | `index.html` stacks five cards in one scroll: a status chip with a nine-row fact list, the step card with its buttons, the tray switch, a 220px log pane, and a Danger zone disclosure. Nothing is a destination; every concern is always on screen. |
| The state is hard to find | The state word ("Running") is a 14px chip. The version, the URL and the pid are three of nine identical rows. The thing a person opens the window for — is it up, where is it, open it — has the same weight as the tmux path. |
| The fact list reads as a debug dump | Nine `dt`/`dd` rows in 14px, four of them carrying a bordered "Reveal" button, two of them (`server cli`, `control plane URL`) duplicating what a status hero would say. Labels are lowercase machine words. |
| The log competes with the controls | The pane is always visible, capped at 220px, and sits directly under the action buttons. It is the largest and busiest element on a page whose job is a few buttons. |
| Editing addresses replaces the step | "Change addresses…" is an OVERRIDE of the step area (`override = "configure"`): the page's one card changes purpose in place, and Cancel is the only way back. |
| The tray switch is a card by itself | A single checkbox has the same card chrome and position as the server controls. |

## 2. The shape

A **System Settings** shape: a sidebar on the left listing four sections,
a content column on the right showing one. Overview is the one that
matters; the other three exist so that Overview can be quiet.

```
┌──────────────────┬──────────────────────────────────────────────────────┐ 900 × 640 default
│  [wordmark]      │                                                      │ min 720 × 520
│                  │   ●  Running                                         │
│  ● Overview      │      subshell-server 0.2.0                           │
│    Addresses     │      http://localhost:3080   Open in browser         │
│    Logs          │                                                      │
│    Settings      │   [ Open Dashboard ]  [ Restart ]  [ Stop ]          │
│                  │                                                      │
│                  │   Restarted.  Show output                            │  result strip (§ 4.3)
│                  │                                                      │
│                  │   DETAILS                                            │
│                  │   Server binary   ~/.local/bin/subshell-server       │
│                  │                   installed by this app       Reveal │
│                  │   config.env      ~/.config/subshell-server/… Reveal │
│                  │   Service         ~/Library/LaunchAgents/…    Reveal │
│                  │   Manager         running (pid 48599)                │
│                  │   tmux            /opt/homebrew/bin/tmux             │
│  0.2.0           │   Logs            ~/Library/Logs/subshell-…   Reveal │
└──────────────────┴──────────────────────────────────────────────────────┘
```

The reset view (§ 8) is a full-window takeover over BOTH columns, exactly
as it is a takeover of the whole page today.

### 2.1 Geometry

- **Window:** `open_console` (`src-tauri/src/windows.rs`) builds the
  console at **900×640**, min **720×520**, resizable — up from 720×620 /
  560×480. A 200px sidebar beside a content column with 32px side padding
  leaves 636px of content at the default size and 456px at the minimum;
  the assistant's column is 560px. Pin the two sizes as named constants
  with a test beside the existing `MIN_WIDTH` assertion.
- **Sidebar:** 200px, full height, the same `--color-bg` ground as the
  page with a hairline `--color-line` right border. Top: the product
  wordmark (`wordmark-96.png` / `wordmark-192.png` at 2x, already in
  `ui/public`), 22px tall, 20px inset. Below it, 12px down, the four items.
  Bottom: the server CLI version in 12px `--color-muted` (`probe.server.version`,
  or nothing before the first probe, or "no server" when `probe.server` is
  null).
- **Nav item:** 14px, 7px 10px padding, 7px radius, `--color-muted` text at
  rest, `--color-fg` on hover, `--color-fg` on a `--color-card` background when
  current. Plain `<button type="button">` elements in a `<nav aria-label="Sections">`,
  the current one carrying `aria-current="page"`. Overview's item carries an
  8px dot BEFORE its label that mirrors the hero's state colour (§ 4.1), so
  the machine's state is readable from any section. No other item has a dot.
- **Content column:** scrolls independently of the sidebar
  (`overflow: auto`), padding 28px 32px 32px. Each section is a `<section>`
  with `hidden` toggled; only one is visible. Sections have NO card chrome
  around them as a whole — the ground is the window, as in the assistant.
  Groups within a section use a 12px uppercase 0.06em-tracked
  `--color-muted` heading ("DETAILS", "TRAY", "RESET") rather than a bordered
  card, except where § 4–7 say otherwise.
- **Buttons, inputs, `.primary`, `.ghost`, `.linkish`, `.mini`:** the existing
  element defaults and variants in `styles.css` are kept. The `.primary`
  gradient stays the SPA's `button.tsx` copy.
- **Motion:** a section change crossfades the content column (120ms
  ease-out, `prefers-reduced-motion: no-preference` only). Nothing slides.

### 2.2 Voice

Labels in the Details list are sentence case and name the thing, not the
CLI field: "Server binary", "config.env" (a file name stays a file name),
"Control plane" is not a row any more (the hero has it), "Service",
"Manager", "tmux", "MCP entrypoint", "Port", "Teardown", "Logs". State
words are the existing ones (§ 4.1). The CLI's own words are still shown
verbatim and never re-worded — the rule at the top of `main.ts` stands.

## 3. Navigation

Four sections, a fixed order, and one pure module that decides what each
may show.

| id | label | shows |
|---|---|---|
| `overview` | Overview | hero, step + actions, result strip, details |
| `addresses` | Addresses | the configure form, or why it cannot be used here |
| `logs` | Logs | the two-tab pane, full height |
| `settings` | Settings | the tray switch, the reset entry |

- **`ui/src/lib/console-nav.ts`** (pure, tested) exports:
  - `SECTIONS: readonly SectionId[]` in the order above, and the label map.
  - `addressesAvailability(probe: Probe | null): { ok: true } | { ok: false; reason: string }`
    — `ok` exactly when a save can work: the step is one of `unreachable`,
    `install-service`, `start`, `ready`. For `no-server` and `setup` the
    reason is "There is no server to configure yet. Set one up from
    Overview first." For `init` it is "This server has no configuration
    yet. Create it from Overview, where the first save also starts the
    service." For a null probe: "Checking this machine…". This is the
    same rule the setup step's test already pins for the step buttons
    (`config-form.test.ts`, "the setup step offers nothing that cannot run
    without a server"); it now lives in one function instead of in which
    steps list "Change addresses…".
  - `heroState(probe: Probe | null, busy: boolean): { word: string; tone: "ok" | "warn" | "muted" }`
    — the `renderChip` logic, moved: `busy` → "Working…"/muted; null probe →
    "Checking…"/muted; service running → "Running"/ok; service installed →
    "Installed: <state>"/warn; server found → "Not installed as a
    service"/muted; else "No server found"/muted.
- **No section is ever disabled in the sidebar.** The console's rule that no
  disabled control lacks its reason beside it is easier to keep by letting
  every item open and having the SECTION say why it has nothing to offer
  (Addresses, § 5). A dimmed nav item with a tooltip fails that rule on
  every platform where hover does not exist.
- **The current section is page memory, not machine state.** It is a
  module-level `let section: SectionId = "overview"`; the poll never
  changes it. Two things do besides a click: a completed action whose
  section is Addresses (`doConfigure` succeeding) returns to Overview
  (§ 5), and the reset view's Cancel returns to the section that was
  current when it opened (§ 8).
- **Deep links** stay exactly one: the `desktop-screen` event with payload
  `"reset"` raises the reset view (§ 8). There is no event for choosing a
  section; the SPA cannot navigate this window.

## 4. Overview

### 4.1 The hero

Replaces the chip + fact list. No card. Three lines, left-aligned:

```
●  Running                                   dot 10px, state 20px / 600
   subshell-server 0.2.0                     15px --color-muted; "no server found" when probe.server is null;
                                             "unknown version" when the version is null
   http://localhost:3080   Open in browser   15px; the URL in --color-fg, the action a .linkish
```

- The dot colour is `heroState().tone`: `--color-ok`, `--color-warn`,
  `--color-muted`. The same tone drives the Overview nav item's dot.
- The URL line renders only when `probe.status.settings.APP_BASE_URL.value`
  exists. "Open in browser" calls `openControlPlane` — the existing
  intent-not-URL rule; the page never sends the address.
- Under the hero, the `problem` line: 14px `--color-warn`, `empty:hidden`,
  unchanged in meaning (the CLI's own failure text, or the guard's one
  sentence).

### 4.2 The step and its actions

The `STEPS` table, `renderStep`, `button`, the tmux warning, `buildForm`
for the `init` step, the upgrade offer, `fallbackStep`, and every guard
(`doSetup`, `doInit`, `doRestart`, `doStop`, `doUpdateServer`,
`doInstallTmux`, `pickBinary`, `retry`, `service`) are **kept as they are**,
moved into `ui/src/console/steps.ts` (§ 9). Two changes:

1. **`configure` leaves the table.** It was a step the user chose, held in
   `override`; it is now the Addresses section. Delete `override`,
   `showConfigure`, `cancelConfigure` and the `configure` entry. Remove
   `["Change addresses…", showConfigure]` from `unreachable`,
   `install-service`, `start` and `ready` — the sidebar item is the way
   there. `doConfigure` moves to the Addresses module (§ 5).
2. **The step body is a sentence, not a card.** `#step-body` at 15px, the
   hint at 14px muted under the buttons as today, buttons in a wrapped row
   with 8px gaps. In the `ready` step the body "The server is running." is
   **not rendered** — the hero has just said it. Every other step keeps its
   body (those are the states where the sentence is the instruction).

The `ready` actions are `Open Dashboard` (primary), `Restart`, `Stop`. The
tmux-gate flags, the `needsTmux` fourth argument and the labels the
config-form tests pin ("Set up and start", "Save and start", "Install and
start as a service", "Start") are unchanged. "Save and restart" moves with
`doConfigure` to the Addresses module and stays tmux-gated there.

### 4.3 The result strip

Today a command's output takes over the log pane's tab. With Logs a section
away, an action's outcome needs one line where the button was pressed.

- `guard()` gains a `label` (the button's label, passed by every caller)
  and records `lastResult: { label: string; ok: boolean; hasOutput: boolean } | null`
  when the action settles. Cleared to null at the START of the next action
  (where `show(null)` runs today).
- Rendered between the actions and Details: one line, 14px. `ok` →
  "`<label>`: done." in `--color-muted`; failure → the guard's failure
  sentence in `--color-warn` (this REPLACES the sentence "That did not
  work. See the output below." — the output is no longer below; the new
  sentence is "`<label>` did not work."). When `hasOutput`, a `.linkish`
  "Show output" follows, which sets `section = "logs"`, `showPane("output")`
  and renders. A `.linkish` "Dismiss" (×) ends the line and clears
  `lastResult`.
- The `problem` line under the hero still carries a REJECTION (a thrown
  command, a probe error), unchanged. An `ok:false` result now lands in the
  strip rather than in `problem`; the two never say the same thing twice.
- `show()` no longer switches the visible pane tab on its own — it only
  writes `#output` and toggles `output-bad`. The tab switch happens only
  through "Show output" or a click on the tab. `syncPaneTabs` (offer the
  Command output tab only when there is output; never strand the selection)
  is unchanged.

### 4.4 Details

The `fact()`/`renderFacts()` machinery is kept, moved to
`ui/src/console/facts.ts`, with these row changes:

- **Removed:** `server cli` (the hero shows the version) and
  `control plane URL` (the hero shows the address).
- **Renamed:** `found at` → "Server binary"; `service` → "Service";
  `manager` → "Manager"; `logs` → "Logs"; `mcp entrypoint` → "MCP
  entrypoint"; `port` → "Port"; `teardown` → "Teardown"; `this app's own
  copy` → "This app's copy". Every other row and its condition stays,
  including the comments explaining each.
- **Layout:** `grid-template-columns: 132px 1fr`, 13.5px, 6px row gap,
  label `--color-muted`. The "Server binary" value puts the rung sentence
  (`SOURCE_LABELS`) on its own muted line under the path rather than in
  parentheses. The row action ("Reveal") is a `.linkish` at the end of the
  value, 13px, not a bordered `.mini` button. `.mini` is removed from the
  stylesheet if nothing else uses it after this.
- The group heading "DETAILS" per § 2.1.

## 5. Addresses

The configure form as its own page.

- **When `addressesAvailability(probe).ok` is false**, the section renders
  the reason as its only content — 15px, then a `.ghost` "Go to Overview"
  button — and no form. Re-evaluated every render, so a machine that
  becomes configurable while the section is open grows the form on the
  next tick.
- **When `ok`:** the body sentence "Change the addresses this server listens
  on and answers to." and the existing hint (the "Invalid origin" sentence,
  which is the disclosure that matters and stays verbatim), then
  `buildForm()`, then `[ Save and restart ] (primary, tmux-gated)  [ Cancel ] (ghost)`.
  The tmux warning is appended after the buttons exactly as `renderStep`
  does, because `Save and restart` is tmux-gated and the reason must be
  beside it.
- **Seeding** happens when the section is ENTERED, not on every render:
  entering runs what `showConfigure` does today (`form = effectiveForm(…)`,
  `explicit = explicitFields(…)`) and rebuilds the form once. Typing then
  owns the values, as today; the poll's re-render must not rebuild the
  inputs (the focus-loss lesson in `renderStep`'s comment applies here
  unchanged: rebuild only when the section is entered or the availability
  flips).
- `doConfigure` is unchanged in what it does (write, then restart if a
  service is installed, else say the save takes effect when one is). On
  `ok`, it sets `section = "overview"` before the final render, so the
  person lands on the hero and the result strip ("Save and restart: done.").
  On failure it stays on Addresses with the strip rendered THERE — the
  result strip is a component the Addresses section also renders, under its
  buttons, for exactly this case.
- Cancel sets `section = "overview"` and discards the typed values (the
  next entry reseeds).
- The `form`/`explicit` state and `buildForm` are shared with the `init`
  step on Overview. They live in `ui/src/console/config-form-view.ts` (the
  DOM half; `lib/config-form.ts` stays the pure half), imported by both
  `steps.ts` and `addresses.ts`.

## 6. Logs

- The two-tab pane (`Server log` / `Command output`, `role="tablist"`, the
  `#pane-source` caption, `refreshLog`'s stick-to-bottom behaviour,
  `.pane-pre:empty` collapsing, the muted note when there is no log yet) is
  unchanged, moved to `ui/src/console/logs.ts`.
- The section is a flex column; the visible `.pane-pre` gets `flex: 1;
  min-height: 0; overflow: auto` and the 220px `max-height` is removed for
  panes inside this section. The pane fills whatever height the window
  has.
- `refreshLog` still rides the poll regardless of which section is
  visible — so the Logs section is current the moment it is opened, and
  the result strip's `hasOutput` is always true to what the tab holds.
- The caption shows the log's `source` path in 12px muted, right-aligned,
  as today.

## 7. Settings

Two groups, each with a § 2.1 heading.

- **TRAY:** the `.switch` checkbox with its label "Keep running in the menu
  bar or system tray when the window is closed", the `not-detected` reason
  and its "Check again" button — `loadPrefs` and the `change` handler
  unchanged, moved to `ui/src/console/settings.ts`. When `trayStatus` is
  `unsupported` the whole group is hidden, as the card is today. On a
  platform where that hides the group, Settings still has the reset group,
  so the section is never empty.
- **RESET:** the sentence "Reset this machine's Subshell instance: stop the
  server, delete its database, logs and settings, and return to setup. The
  installed server binary stays." and the red-outlined button "Reset this
  machine…". This is no longer a `<details>` disclosure and there is no
  "closed on every render" logic. The disclosure existed because the
  section shared one scroll with everything else and could be passed
  without reading; on a page a person chose to open, as its last group,
  with the button under its own explanation, the sentence is read before
  the button is reached. The button's handler is `armReset` then
  `showReset` — unchanged.

## 8. The reset view

Content, arming, the hostname rule, `renderReset`, `showResetResult`, the
Retry re-label and the `desktop-screen` listener are **unchanged**, moved
to `ui/src/console/reset-view.ts`. What changes is only how the view is
shown:

- It hides the whole two-column shell (`#shell`) and shows `#reset-view`
  in its place, so a person mid-reset cannot switch sections under it.
- `showReset` records the current section; Cancel restores the shell and
  returns to that section (Settings when entered from the button, whatever
  was current when the deep link fired).
- Styling: the title at 20px/600, the rest as today. The confirm input and
  the two buttons keep their row. `#reset-log` keeps its `scrollIntoView`.

## 9. Code organization

`ui/src/main.ts` is 1309 lines and holds every concern; the split rule in
`.claude/rules/code-style.md` (~300–400 lines, one responsibility) applies.
Target shape:

```
ui/
├── index.html                 # the shell: sidebar + four <section>s + #reset-view; every id the page binds
├── src/
│   ├── main.ts                # entry: state, render(), guard(), poll, nav wiring — under ~300 lines
│   ├── console/
│   │   ├── state.ts           # the shared mutable state object and its type (probe, busy, problem, section, lastResult, form, explicit)
│   │   ├── hero.ts            # renderHero(): the three lines + the nav dot
│   │   ├── steps.ts           # STEPS, renderStep, button(), the tmux warning, fallbackStep, the action guards
│   │   ├── config-form-view.ts# buildForm() — the DOM half of lib/config-form
│   │   ├── addresses.ts       # the Addresses section: availability, seeding on entry, doConfigure
│   │   ├── facts.ts           # renderFacts()/fact()/SOURCE_LABELS/reveal actions
│   │   ├── result-strip.ts    # renderResultStrip(target: HTMLElement)
│   │   ├── logs.ts            # the pane: showPane, syncPaneTabs, refreshLog, show()
│   │   ├── settings.ts        # loadPrefs and the tray handlers
│   │   └── reset-view.ts      # the reset view, unchanged in behaviour
│   ├── lib/
│   │   ├── console-nav.ts     # NEW, pure: SECTIONS, addressesAvailability, heroState
│   │   └── …                  # config-form, installers, ipc, reset, wizard-state — unchanged
│   └── __tests__/
│       ├── console-nav.test.ts   # NEW
│       └── …
```

Rules for the split:

- **`state.ts` holds the state; `main.ts` owns `render()`.** Modules export
  `renderX(state)` functions and take callbacks for anything that mutates
  state or triggers a render, so no module imports `main.ts` (a cycle is a
  TDZ crash at module load — the tmux warning's comment about `doInstallTmux`
  records the class of bug). `guard()` lives in `main.ts` and is passed into
  `steps.ts`/`addresses.ts` as a dependency at construction, or those
  modules export factories that take it.
- **Every comment that explains a decision moves with its code.** The file is
  unusually well-argued; the split must not shed the arguments. Where a
  comment references "below" or "above", fix the reference.
- **No `innerHTML`** except the wordmark `<img>` which is static markup in
  `index.html`. The CSP (`script-src 'self'`, nothing inline) is unchanged;
  `tauri-config.test.ts`'s rules for `index.html` must still pass.
- **`el(id)`** stays the one way to reach the DOM, and every id the page
  binds is declared in `index.html`.

## 10. Tests

- **New:** `__tests__/console-nav.test.ts` — `SECTIONS` order and labels;
  `addressesAvailability` returns `ok` for exactly the four steps and a
  distinct reason for each of `no-server`/`setup`, `init`, and null;
  `heroState` word and tone for every branch including `busy` winning over
  everything.
- **Repoint, do not weaken:** `config-form.test.ts` reads `ui/src/main.ts`
  by path for three source-level pins (the failure-line ordering in
  `guard`, the tmux-gate flags on the five labels, the setup step's
  exclusion of `showConfigure`/`doInit`). Point each at the module that now
  holds the code (`main.ts` for `guard`, `console/steps.ts` for STEPS, and
  `console/addresses.ts` for "Save and restart"). The setup-step assertion
  becomes: the `setup` entry contains neither `doInit` nor any reference to
  the Addresses section (`"addresses"`), which is the same promise in the
  new vocabulary.
- **`ipc-acl.test.ts`:** `commandsInvokedBy("main.ts")` must become the
  union over `main.ts` and every file under `console/` — the console page's
  reachable command set is now spread across modules, and the pin is
  "exactly what `console.json` grants". The wizard's pin is untouched. The
  union must still equal the grant EXACTLY; nothing in this design adds or
  removes a command.
- **`windows.rs`:** a test pins the console's default and minimum sizes to
  the § 2.1 numbers, beside the existing `MIN_WIDTH == 1024` assertion.
- **The `.warn-text` cascade pin** in `config-form.test.ts` (`.hint` before
  `.warn-text`, same layer) stays true of the new stylesheet.

## 11. Verification

From the repo root, in this order, all green before the work is called
done:

```bash
bun run verify-types
bun run lint:check
bun run test
bun run rust:check          # windows.rs changed
bun run dev:desktop-server  # then look at every section, and the reset view, by hand
```

The by-hand pass checks, at the default size AND at the 720×520 minimum:
each of the four sections; the Overview hero in `ready` and in one
non-ready step (press Stop on Overview and watch the hero, the nav dot and
the step change on the next tick, then Start again); the
result strip after Restart with "Show output" landing on the Command output
tab; Addresses refusing with a reason while no server is configured
(temporarily rename `config.env` if needed, and restore it); the Logs pane
filling the window; the reset view covering both columns and Cancel
returning to Settings. Screenshots of Overview and Addresses go in the PR.

## 12. Implementation order

Each step leaves the app working; commit after each.

1. `lib/console-nav.ts` + its test (pure, no DOM).
2. `windows.rs` sizes + test; `rust:check`.
3. The split of `main.ts` into `console/*` with NO behaviour change —
   `index.html` unchanged, every existing test passing after repointing
   (§ 10). This is the risky commit; keep it mechanical.
4. `index.html` shell + `styles.css` sidebar/hero/section styles + nav
   wiring in `main.ts`; sections render into their new homes. `configure`
   leaves STEPS and Addresses becomes a section.
5. The hero, Details trims and renames, the result strip.
6. Logs full-height; Settings groups; the reset view over the shell.
7. `apps/server/desktop/AGENTS.md` "Where things live": the new tree,
   and the sentence "`ui/src/main.ts` holds only the DOM" becomes "the
   console's DOM lives under `ui/src/console/`, one module per section,
   with `main.ts` as the entry".
8. A changeset for `@internal/desktop-server` (the SPA is not touched, so
   nothing for `@internal/server`).

## 13. Out of scope, on purpose

- **A server-binary picker in Settings.** `pickBinary` stays a step action
  on `no-server`, `setup` and `unreachable` — the states where the choice
  means something. Offering it while a service is running invites replacing
  the binary under a live server for no reason the console can state.
- **Keyboard shortcuts for sections**, a search field, a light theme, or
  remembering the last section across launches. The console opens on
  Overview every time because Overview is the answer to why it was opened.
- **Any change to what the console can DO.** Same commands, same ACL, same
  guards, same CLI-owned wording. This is a reorganization of one page.
