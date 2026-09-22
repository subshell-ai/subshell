# The desktop assistants converge on React and one rail; the FTE stays a walk

Design, 2026-09-21. Operator ruling: the server desktop assistant becomes TSX
like the client's, and gains a sidebar rail of options; the same rail ships on
Subshell Client; and **the rail never applies to the first-time experience**
(operator's words: "i do not want a sidebar applied to the FTE").

## The problem

The server assistant (`apps/server/desktop/ui`) renders by hand-building DOM
in `wizard.ts` (~2900 lines). That shape produced three defects in one day:
the recovery screen's four actions flowed onto one mashed line, clicks were
eaten by the poll's unconditional DOM teardown, and the churn gate that fixed
the clicks needed a catch-up rule to stay correct. The client assistant
(`apps/client/desktop/ui`) is React from day one and has none of that
machinery, plus a real component-test harness. The two apps diverged for no
reason that still holds.

## What changes

### One shared shell package

`packages/assistant` (`@internal/assistant`, Apache-2.0) holds the primitives
both apps now genuinely share:

- **`Frame`** — the fixed shell: title, subtitle, problem line, content region,
  bottom bar with left and right slots.
- **`Rail`** — the sidebar: a list of sections, an active one, a select
  callback. Presentational only; each app passes its own sections.

Screens do NOT live in the package: the two assistants drive different CLIs
and probes. Each app composes its own screens from the package's primitives.

**Screens use the shadcn kit, not raw elements** (operator ruling 2026-09-22,
mid-wave-1): each app carries its own copy of the kit (Button, Input, Label,
Badge, Switch, CopyButton — the client's `components/ui/` set, files copied
verbatim), and screens compose it, the way the client assistant always has.
The Frame stays hand-composed in the package — a frame is not a shadcn
primitive. Copy stays verbatim; what changes is the element under it.

Both apps' Vite builds consume it; turbo builds it before either.

### The server assistant's port is presentation-only

The decision layer is already pure, tested TypeScript in `ui/src/lib/`
(`wizard-state`, `update-act`, `config-form`, `recovery-model`,
`permissions-model`, `pane-force`, `settings-screen`, `reset`, `installers`,
`copy-flash`). It survives untouched; components consume it. What is rewritten
is the DOM-building render code in `wizard.ts` and `assistant/`.

The IPC boundary does not move: every `desktop_*` command, every event, every
wire word, every enum. `ipc-acl.test.ts`, `wire-names.test.ts` and the Rust
ACL pins are untouched by construction. The requested-screen enum
(`reset::Screen`), `desktop_pending_screen`, the boot resume, the update
marker's two phases, the reset chain's typed-hostname contract: all keep their
shapes. This is the load-bearing rule of the whole design: **a rewrite of the
renderer is not a renegotiation of the machine's contracts.**

### The rail, server app

Five sections (the fifth by operator ruling 2026-09-22, live screenshot):

| section | content |
| --- | --- |
| **Status** | running state (the handoff view) or the recovery diagnosis, with the server facts and log tail rendered INLINE — operator ruling 2026-09-22: what was the Show Details disclosure is part of the Status section, not a disclosure |
| **Update** | the one update act, both phases |
| **Service** | supervision: service or app child |
| **Addresses** | the four address values and their restart |
| **Reset** | the destructive door, styled in the destructive token. The DOOR is in the rail (`onSelect` is the paired screen-set-and-open); the SCREEN stays full-window — its "only thing happening" premise is the safety design that leaves no way out from under the chain, so no rail renders while it is up |

The rail is also the navigation once it is present (operator ruling
2026-09-22): the standing screens' own leave buttons — Back on Service,
Back on Addresses, Close on Update — render only where the rail does not. A
requested screen rendered over a mid-first-run machine has no rail, and
there the leave button is still the only way out. Leaving via a rail select
discards, exactly as Back did. Permissions keeps its Back/Continue
untouched (full-window, no rail).

Rendered full-window WITHOUT the rail: **Reset's screen** (its premise is
that it is the only thing happening), **Permissions** (a handoff moment with
its own Back/Continue), and every first-run screen (below).

### The FTE rule

`screensFor` already returns the journey family, and that is the
discriminator. Welcome, tmux, Setting Up (progress), and the handoff render
rail-less and full-window, exactly as today. The rail appears when the machine
is onboarded and no first-run step is in progress. Recovery is not FTE and
gets the rail, Status selected.

A requested screen (`update`, `supervision`, `settings`) lands on its rail
section. `reset` and `permissions` land on their full-window screens.

### The poll becomes React state

`useServerState` follows the client's `use-node-state`: a 1500 ms probe,
skipped while an action is in flight, `setState` on change. React
reconciliation ends the DOM-teardown disease structurally: no element is
destroyed under a pressed pointer, so the click-eating class of bug and the
`poll-gate` catch-up machinery both retire. The typing guard is subsumed by
controlled inputs. The poll's other rules survive: no tail pull while the
disclosure is closed, no redraw while an action holds the screen (the action
re-renders through its own state).

### The client app

Its screens are already components. It gains the same `Rail` for its standing
set — **Status**, **Service**, **Control Plane**, **Update**, **About** —
while its FTE walk (Welcome → Choice → Register/Connect → Setting Up) stays
untouched and rail-less, and Reset stays frame-replacing. The tray's
`desktop-screen` events (`about`, `update`) select the rail section they
name.

Two follow-up rulings (operator, 2026-09-22, live screenshots) split the
client's status screen the way the server's recovery screen was split: the
node's machinery (install offer, service verbs, pane-safety rewrite, the
node's reveals) moves to a **Service** section — whose subtitle carries the
"what is a node" half the install explainer dropped ("lengthy as heck"); the
plane addresses (the configured one, the way to change it, "Open in browser
instead", the node's repoint machinery and its coherence card) move to a
**Control Plane** section, which shows the address labeled instead of
narrating "This app opens <url>". The node-behind doors the status screen
carried are gone — the Update section is the door — and the facts render
INLINE, no disclosure, the same reason the server's Show Details went.

More rulings from the same operator session (2026-09-22, screenshots
52/53), on the client: the not-a-node sentence on the status screen is
deleted outright; the badge for `no-node` reads "Not registered as a node"
(house sentence case over the operator's typed capital-N); the `bundled` and
`tmux` fact rows render ONLY on the Service section; the Control Plane
section's address row is rebuilt into the server Addresses card's form shape
(labeled value row, acts grouped on their own row) because the one-line
value with its buttons beside it wrapped the URL character-broken; and the
plane's DOORS rearrange — the status screen loses "Open Dashboard" and
gains the ghost "Open in browser", while the Control Plane section carries
both doors for the plane itself ("Open the control plane" for the in-app
window, "Open in browser" for the system browser). Re-enroll… moved to the
Control Plane section the same day: it is an act on the machine's
relationship to the plane, and the status screen keeps machine state only.
Two addenda, still 2026-09-22, supersede parts of the above: the install
explainer is deleted outright and the button reads "Install the Subshell
Node CLI"; and the doors' final state puts Control Plane FIRST — it is the
landing (`clientScreen`'s configured case answers `plane`), it reads first
in the rail, every rail select is an override (Status included, since
clearing would land on Control Plane), the status screen carries NO door at
all, and the Control Plane section's Dashboard card carries both doors
("Open in browser" for the system browser, "Open in app" for the in-app
window).

### The facts' home, and the register act's (operator ruling 2026-09-22,
### screenshot 60)

The facts render on the STATUS screen ALONE — "that data should only be in
the status panel" — superseding the same day's screenshot-52 scoping that
kept bundled and tmux on Service: one list, one panel, full. A screen that
needs a fact to explain a state says it in its own card's sentence, and the
config fact's value is plain language ("Not enrolled. Go to Service to
enroll." / "The node's configuration could not be read."), the CLI's raw
words rendering only as an action's failure output. **Register this
machine** leaves the status screen for the Service section beside the
install offer (the node's machinery home): same handler, same walk entry,
the override-clearing wiring re-traced and re-pinned on the new screen.

### Testing

The client's harness ports to the server app: `ui/bunfig.toml` +
`test-setup.ts` (happy-dom, React Testing Library, the Base UI shims), so
component tests render real trees. New coverage: rail routing, each recovery
variant's diagnosis and action, the update act's phases and refusals, the
supervision and addresses forms. Pure `lib/` tests are untouched and stay
green. The old DOM-render code had no tests; nothing is lost.

### The reset layout, superseded (operator ruling 2026-09-22, final word)

"Rendered full-window WITHOUT the rail: Reset (its premise is that it is the
only thing happening)" no longer holds for the CONFIRMATION — the user was
losing the sidebar on it, and that is not wanted. Both apps: the reset
confirmation renders inside the frame WITH the rail, reset active and
danger-styled; the ROOM is the RUNNING chain — from the confirm press until
the chain ends the rail and bar hide and the view goes full-window again
(the meter/log render is the full-window one). No navigation beside a
running chain is where the safety property lives now; it moved down to the
chain, not away. The hostname gate, the danger styling, the re-arm chain and
the deep link's gate are untouched; the SPA deep link lands the
confirmation with the rail.

## What does not change

- The 1024x720 fixed window, its zoom ladder and frame arithmetic.
- The title-bar negotiation, the tray, the menu bar, `open_home`.
- Boot resume, the update marker, the update act's two phases.
- The reset chain: plan stashing, typed hostname, containment guards, step
  meter, the app restart.
- CSP: `script-src 'self'`, module scripts, no inline.
- The design system: same tokens, `lint:design` still passes, copy rules
  (≤2 sentences, no em dashes) apply to every reworded line.

## Sequencing

Each wave is its own reviewed and merged PR.

1. **Wave 1 — the package + the port, behavior preserved.** Scaffold
   `packages/assistant` (Frame; Rail is added in wave 2), port the whole
   server assistant to components inside one host component, with the rail
   NOT yet rendered (screens keep their current full-window layout). The FTE,
   the chains, the latches keep their semantics as React state. Gates green.
2. **Wave 2 — the rail, server app.** Rail on Status/Update/How it
   runs/Addresses; the FTE family, reset and permissions stay full-window;
   requested screens select their section. Rail added to the package.
3. **Wave 3 — the rail, client app.** Same rail on Status/Update/About; FTE
   untouched.

Docs (`apps/server/desktop/AGENTS.md`, `apps/client/desktop/AGENTS.md`) are
rewritten by the wave that changes the surface they describe.

## Risks

- **The port is mechanical only if the latches move as a group.** The state
  that decides WHAT renders (busy, running, screen, requested override, the
  update act's phase state, the forms, the setup chain's `ranSetupHere` and
  friends) moves into one host state object, ported value-for-value. A latch
  dropped is a screen that misfires; the component tests exist to catch it.
- **`checkPort`'s conditional render disappears as a problem** — React
  re-renders are cheap and inputs are controlled — but the port check's
  async-while-typing ordering must still be preserved (stale answer for a
  superseded port is dropped).
- **HMR during development loads the page twice on edit**; the boot probe and
  `desktop_pending_screen` pull must be idempotent under remount (they are
  reads).
- Wave 1 is large (~3k lines touched). It is split inside the wave: frame +
  first-run screens first, then the standing screens, one branch, two
  commits.
