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
untouched and rail-less, and Reset stays frame-replacing (until the same
day's dialog wave, Addendum 8: it became a dialog over the standing
section). The tray's
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
chain, not away. What the room KEEPS is the press itself, disabled and
labelled "Resetting…" — a bar that empties the moment the one irreversible
button is pressed reads as a hung window, not a running chain (the server's
button has carried that label throughout; the client's does too as of the
fix wave, standing in for the meter whose step events only the server's
chain emits). The hostname gate, the danger styling, the re-arm chain and
the deep link's gate are untouched; the SPA deep link lands the
confirmation with the rail.

### The client's Service and Status join the server's layout (operator rulings 2026-09-22)

"The way we render the status and service pages for the client should match
up the general layout and offerings we do for the server. Consistency in
offering and UI." Four rulings, one wave:

- **The reveal bar is gone** from the client's Service section. The operator's
  words: they "feel out of place", and Status's facts already carry the paths.
  The whole surface retired with the buttons: `node_open_path`, its ACL entry,
  and its ipc wrapper — the three-way pin treats a command no page invokes as
  a surface, not a door.
- **The state chip moved into the Frame header**, between the title and the
  subtitle, on the client's status and service screens. It was a sandwich cut
  between the subtitle and the sentence under it; it is part of the heading.
  The client's own `Frame` gained an optional `badge` slot. The server app's
  shared Frame is untouched — its Status section carries no badge to move.
- **The client's Service section offers what the server's does**, adapted to a
  node: the arrangement stated ("In the background", with the run-at-login
  switch nested under it exactly as the server nests it), the lifecycle verbs
  (Start / Stop / Restart with the CLI's pane-safety refusal read before
  `--force` is offered / Uninstall), and the install-service door for a node
  CLI that is installed but unsupervised — the door the server's supervision
  screen has always offered and this side had no day-2 version of.
  Node-specific differences STAY: there is no app-managed-child supervision
  choice (this app does not supervise its node that way), and the Control
  Plane / Status responsibilities are unchanged.
- **The switch had to become real on the node too**: `subshell service
  autostart on|off` is the CLI's day-2 toggle (Linux `systemctl --user
  enable/disable --no-reload` — never `--now`; macOS moves the plist between
  the login directory and the config home — never a restart), and `service
  status --json` answers `autostart` beside `enabled`, the same fact named
  for the act. The client's Rust passes the verb through `node_service` and
  the probe surfaces the field as it surfaces the whole service body,
  verbatim; an agent too old to answer reads through `enabled`, which older
  agents have always reported.

The copy rules bound everything new: at most two sentences per explanation, no
em dashes in user-visible strings, roles from the token set.

### The client's Status gains the tail, and the reveal comes back (round two, 2026-09-22)

Two audit items the first client wave missed, both from the server's
`StatusDetails`. **The reveal placement**: what the operator called "out of
place" was the BAR, not the affordance — the server's Status rows carry an
inline Reveal on the facts whose value IS a path, naming an intent for Rust
to re-resolve from its own probe. The client's first pass retired the whole
surface (`node_open_path`, its permission, its capability, its ipc wrapper)
with the bar; round two restores all four unchanged and moves the buttons
onto the Status `config file` and `logs` rows, exactly where the server's
sit. A hint row — Linux, where the log is the journal — reveals nothing,
because there is no file to reveal; the hint sentence is itself the remedy.
**The log tail**: Status gains a "Node log" group heading over a scroll-stick
pane, fed only while the section is the shown one (the server host's
`statusUp` rule; the client's tick is the probe query's own `success` event,
since structural sharing makes an unchanged machine's probe data an
undetectable dependency). A new argument-less `node_logs` command tails the
agent's own capped file — Rust locates it from the same `node_paths` the
probe reports, renders JSON-lines to `HH:MM:SS level message`, caps at the
server's 200, and returns `{text, source, note}` so "no file yet" is a
caption, never an error banner. The page can name no file. What is
deliberately NOT ported: the server Status's "Last action" pane — the
shipped output-ownership ruling already decides where an action's words
render (the screen the press happened on), and an always-on second copy would
contradict it. The run-at-login switch also gained the server's version
gate: an agent older than `0.15.0` reads the state (it
always answered `enabled`) but has no verb to write with, so the switch
shows the answer greyed with "Currently the installed version cannot change
this. Updating to version 0.15.0 lets you." (the server keeps its own
shorter sentence for the same gate). And when neither fact arrives there is
no hiding and no guessing: the card itself says so ("Whether it starts on
startup is not reported.") while the disabled affordance stays, never an
absent one, and the switch's own help line goes empty.
The switch's help states the CURRENT condition in every state (armed,
disarmed, unknown, too-old), operator ruling 2026-09-22: the card says what
is, the toggle says what flipping it changes.

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

## Addendum 7 (2026-09-22, same day, plane-list wave + the live-window follow-ups)

The operator's ruling that ended the day's evolution of the Control Plane
section: "the Control Plane should be a list of control planes to connect
to … that way it's clear the section is for connecting to other control
planes, not necessarily tied with the node." What shipped, including the
corrections made from the running dev window as it went:

- **The list.** A bare table (not a card), rows canonicalized and deduped
  by Rust. The node's own address is a PINNED first row badged "this node" —
  a probe fact, never a stored entry, and the pinned row renders exactly
  once whatever spelling a stored row uses. No row is marked connected and
  nothing opens at boot: a client never opens a control plane by itself
  (§ 2 stands; the old plane ladder existed only to feed a `debug_assert`
  and was deleted).
- **The row is the door; the `⋮` is a real action menu.** Pressing the
  address opens the dashboard. The menu — Open in dashboard, Open in
  browser, Copy URL, Remove — is positioned BY CLASS inside the row's own `relative`
  box: the CSP outlaws style ATTRIBUTES (the `confirm-panel.tsx`
  measurement), which sinks measuring poppers but not `absolute right-0
  top-full`, and a list row does not need a popper. It is FIXED-width
  (`w-48`) with dense items (`h-7`, `text-detail`): two rulings from the
  window — the auto-width panel sized to the ROW rather than its labels
  ("why is the action menu so wide"), and button-sized items made the whole
  panel read oversized. Escape and outside
  press dismiss; one is open at a time. The pinned row's menu carries the
  SAME opens plus Copy URL, NO Remove, and no explanatory sentence —
  the pointer paragraph was deleted the same hour Un-enroll… stood up on
  Service ("absence is the whole message") — but the ROUTE survived as a
  plain **Go to Service** item, restored by a later same-day ruling ("what
  happened to going to the Service section"). Copy closes the menu on success
  and, on a refused clipboard, stays open with the item renamed.
- **The add is the frame's bottom bar; its form is a dialog.** The opener
  keeps the bar's primary-right slot; pressing it opens `Add a control
  plane` in the app's dialog, and a submit closes it — the refetched list
  underneath is the feedback. (Both halves are same-day live-window
  rulings; § 3's bar grammar survives as the opener's home.)
- **The node's binding lives on Service.** The "Enrolled to Control Plane"
  card states the address, carries the loopback notice with it, and offers
  Re-enroll… — the ENROLLMENT WIZARD's door (the day's final ruling: "Re-enroll
  should go through the enrollment wizard"): it opens the same walk the
  Register card opens, seeded with the current address, and the bespoke
  free-form repoint dialog it replaced went all the way down with its
  `node_configure` command — re-enrolling spends a setup key and mints a
  fresh node row, and the walk's two-phase confirm over a live config is the
  guard. The close-on-submit grammar it taught stands for every dialog that
  remains: a modal that stays open after the press is zero feedback. And
  Un-enroll… (confirmed; ONE `node_unenroll` call whose chain is stop →
  uninstall → `unenroll --yes --json`, definition before config because a
  kept definition respawns a daemon against a deleted config; panes are
  never signalled and the confirm says so; gated on node 0.15.0, the
  autostart gate's twin). Plane-coherence and its notices died with the
  two-address state — the pinned row IS the notice — and the Status
  subtitle states the machine, not a plane.
- **The press narrates its own button, and the wait belongs to it.** A
  lifecycle or chain press turns the PRESSED button into a spinner and the
  progressive word ("Restarting…"): the runner carries the submission's
  label through a confirmation, so a confirmed chain spins from the dialog's
  Accept to the answer. A STARTING act then does not end on the CLI's
  return — the manager accepts a kick long before the daemon is up (a
  throttled launchd restart measured 10–30 s) — it re-probes until ONLINE
  or a 30 s deadline, which is as close to "confirmed started or unable to
  start" as a poll honestly gets. The header state chip wears the act's word
  while it runs — the last read is stale by design for seconds and "Online"
  over a restart in flight reads as a lie ("why does it say online while
  it's restarting"). The card's problem sentences go quiet for
  the act's whole life (plus one residual cycle), a stop keeping no grace,
  and what survives the hush renders as the screen's yellow warning band.
  Four live-window rulings: "there should be a spinner saying restarting.
  same with the stop / start button"; "when restarting this additional
  message occurs, can we remove it"; "keep it spinning / disabled until
  it's confirmed started or unable to start"; "it should probably be written
  as a yellow warning". A later ruling that night deleted the STOPPED
  sentence outright ("just remove this, the badge already shows the
  status") — only sentences that say MORE than the chip survived: offline's
  disagreement, no-service's absent arrangement.
- **Confirmations are dialogs** (the audit ruling, same hour): every
  confirmation flows through `ConfirmPanel`, and `ConfirmPanel` is now the
  app's own class-positioned `Dialog` — Escape and backdrop are the cancel,
  the accept keeps the right-hand weight. Re-enroll… opens its form in the
  same dialog. Reset followed within the hour — the rail keeps its "Reset"
  item and pressing it opens `Reset everything?` as a dialog over whatever
  section stands, typing the hostname inside it; running, the dialog cannot
  be dismissed, which is the old frame-replacing room's rule expressed
  harder. Uninstall and Un-enroll… stay separate commands by ruling.
- **The tray follows the section, and reset reaches the app's own memory**
  (the last two live-window rulings, same night). "I think we need to update
  the tray menu items because open subshell client / browser - doesn't inform
  which" rebuilt the tray as the Control Plane section's mirror: one submenu
  per saved address — connected one first, the pinned row's rule read from
  the same live sources — each offering Open in App | Open in Browser, and
  the ids carry the canonical URL so a click acts on the address the person
  read. "This machine" became **Open Client App** in both the tray and the
  macOS menu bar: the label is the verb. "Have Control Plane have a Open Last
  option which would open the last used url with the opening method used
  (browser / app)" put one record in settings — the address AND the door —
  written by every opener's success path and replayed by the submenu's first
  item; it greys until the first open and reset clears it with the list. The
  tray repaints on every mutation its submenu reads (plane add/remove,
  enroll, un-enroll, reset) — and never from inside its own menu handler,
  which is a re-entrancy question this app does not answer. And "the reset
  everything didn't seem to reset. the app didn't restart to the FTE"
  reversed the reset's one kept artifact: with the plane list feeding
  `configured()`, keeping it made the first run unreachable forever, so
  reset now clears `settings.planes` and the open-last memory along with
  everything else it names — cosmetic preferences stay — and the dialog
  says the list goes.
