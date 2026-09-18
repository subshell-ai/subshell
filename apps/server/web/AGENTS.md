# Server web AGENTS.md

Documentation for the React SPA the control plane serves (`apps/server/web`,
`@internal/server-web`). It is the SERVER's web UI and nothing else's — which
is what its place in the tree says: it sits beside `apps/server/api`, which
builds it into its binary and serves it. The two desktop apps carry their own
small bundled pages under `<app>/ui/` and share nothing with this one.

**Styling follows `docs/design-system.md`** — six type roles, two weights,
shadcn colour names — and `bun run lint:design` fails on a literal size,
weight or colour outside the token file. Pick a role, never a number.

## URLs

- Dev server: http://localhost:5174 (Vite) — proxies `/api` and `/ws` to the
  backend at 127.0.0.1:3080 so cookies and WS auth just work on one origin.
- Production: the app is built to `dist/` and served by the backend itself.

## Commands

```bash
bun run dev                # Vite dev server
bun run build              # vite build -> dist/
bun run test               # bun test --pass-with-no-tests (unit tests, see Testing)
bun run verify-types       # tsc --noEmit
```

## Layout

```
src/
├── routes/           # TanStack Router file-based routes (workspaces_.$id.tsx = flat nesting)
├── components/       # App components; components/ui/ = shadcn-style primitives (Base UI + cva; see .migration/)
├── hooks/            # Data hooks wrapping TanStack Query (use-workspaces.ts, use-subshell-data.ts, ...)
├── lib/              # Non-UI utilities: api.ts (fetch helpers), auth.ts (current-session helpers),
│                     # query-client.ts, subshell-frames.ts, workspace-layout.ts, ...
└── types/            # Hand-written mirrors of API response shapes
```

Route files stay thin: URL state + handlers + composition; data logic goes in
`hooks/`, reusable UI in `components/`, shared types/constants in `lib/`.

**The sidebar (`components/app-sidebar.tsx` + `components/sidebar/`) is more
than nav.** Recent subshell rows carry a status dot and are the drag source of
"drag a session into a workspace" (targets: `workspace-dock.tsx`'s tiles
wrapper and the `/workspaces` cards; the payload contract is
`lib/subshell-dnd.ts` — handlers react ONLY to its MIME, which is what keeps
xterm's file-drop and dockview's tab-drag untouched). Status words/precedence
live once in `lib/subshell-indicator.ts` (home card badges consume it), and
the dot fills beside it. Subshell lists everywhere are kept current by ONE
SSE feed — `hooks/use-live-subshells-feed.tsx`, mounted in `__root.tsx`
signed-in-only — which writes each `/api/events` frame into
`SUBSHELLS_QUERY_KEY`; read via `useSubshellsList`/`useLiveSubshells`, never
by opening another EventSource.

**The admin surface is NINE pages behind one collapsible group** (spec
2026-09-11 grouped-navigation): General (`/settings`), Users
(`/settings/users`), API keys, Plugins, Service, Networking, Updates, Status
and Audit log, listed in the rail under **Server Settings** and gated as a WHOLE — a member's rail lists
none of them, and none of them renders for a member who types the URL. The
roster page moved INTO the namespace on 2026-09-14 and lost its read-only
member view with it: the roster exists so the sharing picker can name people,
and that reads `GET /api/users`, which is still instance-wide. Two of them
are read-only: `/settings` is where an admin CHANGES the instance, while
Status and `/settings/audit` are where they see what it currently IS and what
has happened to it.

**`/settings/updates` is ONE Components table, not three cards** (2026-09-17).
The two desktop apps, the Server and the fleet share one grid — name / running
/ newest / act — because those are the same four questions in every row, and a
card each put "newest" at a different x per section, so the table's read (scan
the middle two columns, spot the mismatch) had to be reconstructed by the
reader instead of seen. The mechanics are `installed-plugins-card.tsx`'s — its
long comment carries the track sizing and the `display: contents` rows — with
one deliberate divergence: plugins get one grid PER GROUP because their groups
are different kinds of thing, while here the columns must agree ACROSS
sections or the table says nothing. Everything that is not a cell — job
phases, `canApply` blockers, the backup sentence, held-node reasons, a run's
failure — is a `col-span-full` detail line inside its row, in the order the
old cards carried them, and below `sm` the version pair folds into the name
cell as `running → newest` (`row-cells.tsx`). The row order — desktop apps,
Server, Nodes last — is the operator's 2026-09-17 call and is pinned by
`updates-table.test.tsx`, since nothing else on the page would notice a swap.
The old card descriptions ("X is available. Running Y.", "Nodes can be updated
to X.") are gone on purpose: the two version cells state that per row, in one
voice.

**There is ONE new-account form.** `components/account/new-account-fields.tsx`
renders the four fields (name, email, password, confirmation) plus the two
rules that make them usable — the password requirement stated before it is
broken, and a mismatch reported only once the confirm box is left — and both
callers use it: the first-run wizard's first screen and the Add user dialog on
`/settings/users`, which adds only the Role select that setup has no use for.
The admin's form used to be a thinner copy, so the person creating an account
for someone else got less help than the person creating their own.

`routes/settings_.status.tsx` (`/settings/status`, components in
`components/admin-status/`, data in `hooks/use-admin-status.ts`) is the model
for the gate the others copy: server-derived `viewerIsAdmin`, with `undefined`
counting as NOT admin — the query is `enabled`-gated on it so a non-admin
mount fires no doomed 403. It reads TWO routes: `GET /api/admin/status` for
the instance, and `GET /api/admin/server` for the **Locations** card, which
moved here from `/settings/service` on 2026-09-14 because it is the one
Service card carrying no act (the paths live only in the deployment view, so
the page mounts `useServerDeployment` beside `useAdminStatus`). It mounts it
at **60 s**, not the hook's 5 s default: `/settings/service` needs 5 s because
an operator watches it while changing the machine elsewhere, while this page
reads only paths that are fixed for the life of the process — and each poll
of that route is a `Bun.spawnSync` stall for the whole server, so inheriting
the fast cadence would triple the probe load for data that cannot change.
TanStack Query keeps `refetchInterval` per observer, so the two pages really
do poll one shared key at different rates. The two reads fail
independently, so each has its own banner and Retry, and neither failure
hides the other's cards; the Runtime card states the database SIZE only,
since Locations states the path once, copyably. `/settings/audit` is the same shape
(`components/settings/audit-trail-card.tsx`), with the route owning the gate
so the card's query can be unconditional; its `staleTime: 0` is load-bearing,
since mounting the page is now the only thing that refreshes the trail.

**The launch form asks nothing it cannot answer.** `new-subshell-form.tsx`
filters its node options on the server's own `canLaunch` (never a re-derived
rule), hides the Machine field when the sole target is the control-plane host —
a single AGENT node keeps it, because once a second machine exists the answer
is news — and replaces itself with `no-launch-targets.tsx` when nothing is
SELECTABLE. Three pure exports carry it (`isSelectable`, `launchableNodes`,
`hideMachineField`), tested without opening a dropdown.

**Two kinds of unlaunchable, and they are shown differently on purpose** (spec
2026-09-14). A host narrowed by its shares VANISHES: "the machine you were
never granted" is not a choice, and one sentence in the empty state beats the
same sentence on every row. A node in **maintenance** is KEPT and greyed,
labelled ` (maintenance)` as the label's last segment the way `(offline)`
already is — it is a choice with a reason and a way back, and hiding it leaves
a person hunting for a node that simply disappeared. The sole-host-in-
maintenance case belongs to the EMPTY STATE, not to the field: the form returns
`NoLaunchTargets` whenever nothing is selectable, so it never renders with one
greyed row. `hideMachineField` still requires its sole row to be selectable —
zero answers is not one — but as a belt against a caller that skips that gate,
not as the thing that puts a reason on screen.

`no-launch-targets.tsx` therefore takes the node LIST, not `local` alone, and
answers per machine — what is in the way (maintenance first, even on a machine
that is also offline: waking it would change nothing), and for a viewer who
cannot move it, who can. Every route out goes through `leaveFor`, which closes
the containing dialog before navigating; `QuickAddProvider` mounts these
dialogs above the route, so a button that only navigates changes the page
underneath a modal still showing this same empty state. Ending a maintenance
window navigates to the node's page rather than PUTting from here — it re-opens
the machine to everyone it is shared with, so it belongs beside the card that
says what maintenance means and which end declared it. The other unlaunchable
kind gets a different offer for a different remedy: a host nobody is granted
launch access on is fixed by a SHARE, so the button says so and lands on the
page whose header opens the sharing dialog. It used to read "Enable on {name}"
and point at `LocalLaunchCard`, which is gone — an offer that ends nowhere is
worse than no offer, and it ended nowhere for the one person who could take it.

**The form asks Agent → Preset → Node → Working directory** (spec
2026-09-13, presets replace profiles; `#picker-agent` / `#picker-preset` are
the e2e handles, `lib/subshell-compat.ts` holds the pure rules). The Agent
select offers the whole `GET /api/plugins` set, greyed never hidden, and its
default (`defaultAgentId`) is the agent of the user's most recent subshell when
usable — evaluated only after the subshells LIST has ANSWERED, so an
unanswered read cannot outvote the recent one — else the first usable
non-terminal agent, else anything usable; `useSubshellsList()` already holds
the data, so the rule costs no request. Preset lists only the chosen agent's
presets with **None** first and selected; changing the agent resets it to None,
and its `+` opens `create-preset-dialog.tsx` nested in the launch dialog with
the agent locked — a created preset is selected on return. First run hides the
Preset row entirely: a new account has zero presets, so the row would offer
only "None". The saved set lives at `/presets`, grouped by agent under real
`<h2>` headers. A presetless launch omits `presetId` — absence, never null.

**Two cards, because they are two kinds of thing.** `ServiceCard` is about the
running PROCESS — who supervises it, since when, and Restart. `SupervisionCard`
is about the MACHINE: whether anything brings this server back by itself. In
the desktop app that is a choice — which of the two modes it is in, and, below
both, a settings pane's own shape, whether it starts at login. That switch is genuinely
dependent on the background mode (the route 409s under the app, and there is no
definition to arm), but the dependency is carried by a disabled reason naming
the other mechanism, not by nesting: indenting it under the first radio wedged a
control between the two choices so they stopped reading as a pair. They were one card, and it read wrong —
"Restart server" and "change what supervises this machine from now on" sat as
sibling buttons, the second a bare "Run with the app instead…" that named no
alternative and explained nothing.

**`SupervisionCard` is two cards wearing one name, and `isServerDesktop()` is
the seam.** Inside Subshell Server it is a CHOICE — both modes, current one
marked, and the login switch. In a browser it is a FACT and at most one fix.
It used to show the choice everywhere, disabled, which was wrong in both
directions on the machine that matters most: a headless Linux host was offered
"With the Subshell Server app" under a line telling you to change it in an app
that machine does not have, and the control beneath — "Start at login" — asked
a question a server does not have. That label reads as a desktop session, so an
operator who wants no GUI switches it off and loses the server at the next
reboot.

**In the app: the radio IS the choice, and the confirmation is a dialog on this
page.** Clicking the unselected mode opens `SupervisionDialog`, which lists what
the switch does and calls `desktop_set_supervision` through the desktop bridge
(`useSetSupervision`) — no assistant window (operator's call, 2026-09-12;
`docs/security.md` carries the accounting for granting that command to the
SPA window). The radio shows the MACHINE, not the pick — it does not move until
the machine reports the change — so dismissing the dialog cannot leave the
card claiming a mode that never took effect.

**In a browser: `persistence()` answers the one question a person not sitting
at that machine actually has** — will this still be running after a reboot, or
after I log out? One sentence, then a remedy only where the answer is
unsatisfying: the `loginctl enable-linger $USER` command, a **Start
automatically** button (`POST /api/admin/server/autostart`, the `true`
direction only), or the install command. No radios, no dialog, no switch, and
no line telling you to go and find an app.

The off direction is deliberately absent rather than merely unimplemented: a
browser reader is not at that machine, disarming a service strands it at the
next reboot, and nobody sets out to have a unit that runs now and vanishes
later. It stays a CLI act (`subshell-server service disable`).

**The command returning is NOT the switch being done, and that gap needs a
state of its own.** `desktop_set_supervision` answers once the new server is
STARTING; the card cannot move until that server answers. So `useSetSupervision`
has a second phase — `settling` — which polls `GET /api/admin/server` directly
until `currentMode` reports the mode that was asked for, then WRITES the view
it already holds into the cache (invalidating alone costs another round trip on
the exact sentence that is the confirmation). The card renders a spinner and
"Switching to …, waiting for the server to come back", and locks both radios
while it runs; a 60 s cap turns into "The server has not come back." Without
this the dialog closed onto a card still showing the old mode with nothing on
screen saying why, and it read as a page that had ignored the click.
`ServiceCard`'s restart line carries the same spinner, for the same reason.

**The model is `lib/supervision.ts`, not the card.** `SupervisionMode`,
`currentMode`, `loginDisabledReason` and `modeLabel` live there because the
HOOK needs `currentMode` to know when the switch has landed, and importing it
from the component would make a real value-level cycle. `currentMode` answers
`null` for a server nobody supervises — started by hand, a container, the e2e
stack — rather than defaulting to the background mode, which put "A launchd
agent runs it" directly under `ServiceCard`'s "Running, not supervised".

`persistence()` lives there too, and is shared with a card on a different page:
a node's Runtime card asks the identical question about a machine that is
never the one serving this page, so the two answer it in one voice. It returns
a sentence plus a `PersistenceFix` discriminated union and NOT the remedy's
copy, because what "install it" looks like differs per surface — the server
page copies a command, a node page points at the Install service button below
it (the Runtime card renders first) — and a model that shipped the words
would be answering a question it
cannot see. `machine` is a parameter for the same reason: "this machine" on
the Service page, the node's own name on a node's.

**The mode and the login switch are two axes, and the in-app copy has to keep
them apart.** The radio answers WHO runs the server; the switch answers whether
it comes back BY ITSELF next time you log in. Both managers run the server
inside the user's own login session, so it stops at logout either way — which
is why "keeps it running whether or not the app is open" was misread as
covering logins and now reads "runs it, whether or not Subshell Server is
open", with the switch saying what it adds ("nothing brings it back after you
log out or restart"). The desktop assistant's two screens carry the same
distinction.

**On Linux there is a THIRD axis, and it is the one that strands headless
servers.** A `systemd --user` unit runs inside its owner's login session, so an
ENABLED unit still dies at logout unless the account lingers
(`loginctl enable-linger`); with lingering it comes back at boot with nobody
logged in. So "starts at login" and "survives a reboot" are different facts,
and on a box nobody logs in to the first one is worth nothing. The agent and
the server both measure it now (`service.linger`, `null` on macOS where a
LaunchAgent's lifetime IS the login session and no such knob is missing), which
is what lets the browser state which machine you have instead of explaining
both cases at everyone. The in-app radios are unchanged by this, and that is a
DECISION rather than an oversight: the Subshell Server app is the one surface
that measures `linger` and does not show it. Someone sitting at that machine
logs in to it by definition, which answers the reboot half — it does NOT
answer the logout half, and on Linux that half is real even there. What makes
it tolerable is that this surface never claimed otherwise: it offers a choice
about who runs the server, not a promise about how long it lasts. Revisit it
if the app ever ships for a machine its owner does not sit at.

**The act cannot be a route, and the reason is specific rather than the usual
one.** Switching needs an actor that outlives the server: going to app mode
uninstalls the service (stopping the server) and the desktop app is what must
then start it; going back means installing a service while the process holding
the port IS this page's server. So the card carries the choice and the
desktop app carries the act, reached over the webview's IPC — which survives
the server going away, unlike anything the server serves.

Start-at-login itself IS a route (`POST /api/admin/server/autostart`) because
it changes nothing about the running process. `loginDisabledReason` mirrors
that route's three 409s — nothing installed, the app running this server, a
manager that would not say — as a pure export, so the UI never offers what the
server will refuse.

**A node's page mirrors the Service page's behaviour, where a node has the
same question.** Same follow/pause log at one second, same focusable scroller,
same debug switch, same spinner while a restart lands, and `useNode` polls at
5 s — for the change no action on that page causes, the node going offline.
That poll is affordable in a way the server's is not: `GET /api/nodes/:id` is
DB reads plus an in-memory registry lookup, where `GET /api/admin/server`
spawns `netstat` and the service manager synchronously and needs a memo behind
it. Every node mutation writes back or invalidates; `useNodeLogSlice` and
`useSetNodeServerUrl` deliberately do not (a byte-range read driven by card
state, and a value this plane does not store).

Two places deliberately DIVERGE. There is no supervision card: Subshell Client
has no supervisor, so a node has no "the app runs it as a child" mode to
choose. And the Control plane card's "Restart to apply" has no wait-for-return
— that restart sends the agent to a DIFFERENT plane, so watching for it here
would time out and report a failure for the thing working exactly as asked.

**Whether "Add node" is offered is `lib/node-enrollment.ts`, not an expression
at each call site.** Two surfaces ask — the Nodes page and the launch picker's
empty state — and both mirror `POST /api/nodes/setup-keys`'s own gate
(`allow_node_enrollment`, admins exempt) so neither offers a button the route
refuses. The half a second copy gets wrong is the UNKNOWN one: an unanswered
settings read counts as ALLOWED, matching the server's absent-row default,
because reading `undefined` as "off" hides the control from everyone on every
load until the request lands. The argument is `Partial<>` for the same reason —
a payload from a server older than the setting carries no such field. The
button is HIDDEN rather than disabled where it does not apply: a non-admin
cannot make it work, so a greyed control is worse than a sentence naming who
can.

**Maintenance is one flag on the node, and the SPA writes it in one place.**
`NodeMaintenanceCard` sits on every node's Overview (`local` has no other
section) and replaced `LocalLaunchCard`, which was never a switch — ON was the
seeded Everyone/`edit` grant and OFF was its removal. Turning it on stops every
subshell on that machine, other people's included, so the confirmation names a
count: `runningSubshells`, which rides the DETAIL view only and only for a
manager. The Nodes LIST has no such number, which is why `node-list-row.tsx`
exists — it fetches the detail through the query cache at the moment the menu
item is picked, and hedges the prompt rather than refusing the act if that read
fails. `useSetNodeMaintenance` invalidates the subshell list beside the two
node keys, for `useRotateNodeKey`'s reason: rows went `terminated` the instant
it answered. Its response is a `MaintenanceResult`, not a node view, and both
callers SURFACE the `failed` array — a subshell whose kill the node refused is
deliberately not in `stopped`, and everything else on screen (the switch, the
badge, the menu item) moves as if the flip were clean, so dropping it tells
someone a machine is quiet while panes are still alive on it. The wording is
`lib/node-maintenance.ts`, once, for the card and the row.

The Nodes UI (`routes/nodes.tsx`, `routes/nodes_.$id.tsx`, components grouped in
`components/nodes/`, data in `hooks/use-nodes.ts` + `use-node-shares.ts`): the
Add-node dialog's reveal has an **address dropdown, and it names what the
node dials forever** (operator's call, 2026-09-18), not merely the curl's
host — and it sits ABOVE the Terminal / Desktop App switch rather than inside
the terminal panel, because both paths need the same address: the script bakes
it, and the app's Connect step is typed this same URL. Rows come
from the same `lib/install-addresses.ts` the mobile picker builds — the
trusted-origin allowlist, loopback dropped when anything else is known,
falling back to `appBaseUrl` alone when nothing is (`window.location.origin`
only while settings load). The chosen address rides to `GET /install.sh` as
`server=`, which the route bakes **only on exact membership in the live
registry** (`api/install-script.ts`) — because the process cannot observe its
own external address (a TLS proxy shows it loopback, the `Host` header is
client-written, and several names are simultaneously true), so the operator's
choice has to arrive written down, like NetBird's `--management-url` and the
dialog's own `subshell setup --server`. `&server=` is carried ONLY when the
pick deviates from `APP_BASE_URL`, so the stock command is byte-identical to
the one this predates. The amber "APP_BASE_URL points at loopback… replace
the host" paragraph is GONE (operator's call, 2026-09-18): its advice could
not work — hand-editing the curl host changed only the download source, while
the baked `SERVER` came from config — and the dropdown replaced the whole
sentence with the control it was telling you to build by hand. The script's
runtime loopback guard stays: it fires on the new machine, where "is this
address wrong *from here*" is finally knowable. The dialog also reads `nodeArtifactTargets` — the
triples the server actually serves — and names the missing ones (on the mint
screen, BEFORE a single-use key is minted, and on the terminal panel with a
copyable `subshell setup` fallback — `setup`, not `enroll`, because `enroll`
requires `--name` and a person reading a command off a browser should be ASKED
for the name instead): a binary-only server install publishes no agent
binaries until `release:node` runs, and the one-liner 404s on every machine
until then. The field being ABSENT (older server behind a cached PWA) stays
silent; the query still loading or errored shows a "could not check" line
instead — no verdict without data. Opening the dialog refetches so a just-
published artifact set is visible at once. Neither note follows the operator onto
the **Desktop App** panel, and that is the point of that path: the app ships its
own agent binary, so what this server has or has not published is nobody's
problem on that machine. The amber refusal DOES name the app as the third door
while the operator is still choosing.
**The dialog asks no name, and the invariant about the key moved.** Its first
screen used to be a "Node name" field whose text became only the setup key's
`label` — the one-liner never passed it on, so the node was named by its own
hostname whatever was typed. With the 2026-09-17 revamp the field is gone, the mint
takes no body, and the name is asked on the machine (`subshell setup`'s first
question, `--name` for a script, Subshell Client's required Enroll field). So step 1
is ONE press.

What each panel shows is now the SHORTEST true version of itself, because the
explanatory prose was cut on 2026-09-18 (operator's call): the terminal panel had a
paragraph walking through what the script does ("installs the agent to
`~/.local/bin`, asks what to call this machine, enrolls it, and then asks about the
background service…") and the app panel had one walking through opening the app
("In Subshell Client, open Window → This machine…"). **Both are gone** — the command
and the two labelled value rows ARE the instruction, and the script narrates itself on
the machine it runs on. `add-node-dialog.test.tsx` asserts each absence, so neither
regrows as a well-meant restoration. So: **on the terminal panel the key lives inside
a command and never outside one** (one row in the common shape, two — curl and the
`setup` fallback, alternatives that each carry it — on the air-gapped branch), while
the app panel shows the two VALUES its Enroll step takes, address and key, each with
its own copy button that `label`s what it copies. The standalone key box, its "shown
once" subtitle and the tmux paragraph stay gone too. Two sentences of guidance
survive, and both sit where they can still change what the operator does: the amber
no-binary note and the first-run-per-platform sentence, beside the MINT and before the
key exists — after the press the key is minted and the command gets copied either way.

**The reveal is its own component**, `components/nodes/node-key-setup.tsx`
(`NodeKeySetup`, plus `installCommandFor` / `setupCommandFor` / `useSetupKeyVerdict`),
because a second surface needs it: the address picker, the `Terminal | Desktop App`
switch and both panels are a function of a key and of public settings, not of a key
that was minted thirty seconds ago. `AddNodeDialog` keeps only what belongs to a
just-minted key — the create press and the enrollment watcher — and `SetupKeysSection`
renders the same fields for a key minted earlier.

`components/nodes/setup-keys-section.tsx` is that card, and it is the reason the
server can show a key after the mint: `GET /api/nodes/setup-keys` returns each of the
caller's own rows WITH its key text (owner-scoped, cookie-only — a bearer credential
cannot enumerate enrollment doors). The row's title is the key, with
`CopyableValue`'s copy affordance, because the label that used to title it named
nothing a person could match to a machine. `keyState` still decides
unused / used / expired from `usedAt` and `expiresAt`, which is what keeps the
disclosure honest: a spent or stale row's key is inert, and the badge says so.

The row also carries **`Setup`, on the `unused` rows only** — the card hands back the
COMMAND as well as the key. That was the remaining half of the defect: closing the
dialog mid-copy lost the one-liner, and the only way to re-read instructions that had
never actually been lost was to mint a SECOND single-use key. The button opens
`KeySetupDialog`, which is `NodeKeySetup` in a dialog with a Done button and nothing
else. A used or expired row gets no such button by design: its key is inert, and
walking someone to a 401 they cannot act on is not an instruction.

## Subshell for Mobile (the PWA install dialog)

`components/mobile-install-dialog.tsx`, opened from a row of the rail's
`<nav>`, above "Open in browser". Ungated, desktop shells included — it was
`!isDesktop()` for half a day on the reasoning that a Tauri webview cannot
install a PWA, which is true and beside the point: the dialog's payload is a
QR code, read by a DIFFERENT device, and somebody at Subshell Server on their
laptop is the likeliest person in the product to want Subshell on their phone.
The gate hid it from exactly them.

**The steps are the easy half.** The person looking them up is usually at a
desk on an address their phone cannot reach, so the dialog's first control is
an address picker. Candidates come from `lib/install-addresses.ts` (the
shared half, since the Add-node dialog grew the same picker) —
`window.location.origin`, `appBaseUrl` and `trustedOrigins` merged, normalized
to origins and ordered by insertion (the address this browser is
demonstrably on is the best guess for the phone beside it). **And the picker
now explains nothing about itself** (operator's call, 2026-09-18): the
"every address this server accepts a sign-in from…" paragraph and the amber
plain-http note are gone — the audience is developers, and every clause
restated the address bar. The test pins the absence.

**Loopback rows are DROPPED in `installAddresses`, not labelled here.** They
used to be listed and captioned "this device only" — never hidden, never
disabled — because on a stock instance every address looked like that (the
`0.0.0.0` bind contributed none, so the list was the two loopback spellings
plus the dev Vite ports): a disabled version of that picker shipped for an
hour and could not be operated at all, and a hidden one makes the address
someone is looking at vanish. What made the caption survivable was that it
named the cost of a real choice; what makes dropping honest is the server's
LAN derivation (`services/lan-origins.ts`, server side), which puts rows a
phone CAN dial into that same list — a localhost row was never a choice for
the device this picker is for. When an instance genuinely knows no
phone-dialable address (a loopback bind, or a server predating the
derivation), the refusal renders WHERE THE QR WOULD BE, so nothing
unscannable is offered and the empty box names the remedy. Joined networks
keep the behaviour that made the refetch-on-open load-bearing: a tailnet's
addresses are in the list the moment the plugin reports them, with no publish
and no restart, and the empty state says to JOIN a network rather than publish
on one for exactly that reason.

`trustedOrigins` is a field on `GET /api/settings/public` added for this, and
it is the EFFECTIVE allowlist — local origins ∪ this machine's derived LAN
interfaces ∪ the Addresses card's extras ∪ every enabled network plugin's
addresses, computed live, and re-asked of the kernel by the read itself so a
laptop that switched Wi-Fi stops offering the network it left; its disclosure
is accounted in `docs/security.md` §3. Optional in the client type for the
usual reason — a cached PWA can outlive its server — and the dialog falls back
to the origin this browser is already on. `lib/setup-checklist.ts`'s
`lan-origin` item judges this same effective list, so a joined network — or,
since the derivation, the machine's own address on a wildcard bind — silences
it.

Two details that are not decoration. The QR's plate is `bg-white`
unconditionally, because a QR is read optically and dark modules on a dark
surface do not scan in either theme. And the tab group is three GESTURES, not
three brands, which is why macOS Safari sits under **Browser** beside Chrome
rather than under the Apple tab with the iPhone.

## This SPA meets TWO desktop shells, and "desktop" is two questions

`lib/desktop.ts` parses a `SubshellDesktop/…` or `SubshellClient/…` User-Agent
suffix, which each shell's `windows.rs` sets on its remote window. The marker is
a UA suffix rather than an injected script or an IPC handshake because it is
present on the FIRST request, readable before React mounts (so there is no flash
of the wrong chrome), and survives the hard `window.location.href` navigations
at sign-out and after sign-in.

**Two predicates, and picking the wrong one is a control that cannot work:**

- **`isServerDesktop()` — "am I inside Subshell Server".** What every gate that
  predates 2026-09-14 means. It switches on the overlay title bar and its drag
  strip (`useDesktopShellReady` in `routes/__root.tsx`), the server pill, native
  notifications, and the update, reset and supervision surfaces. Each of those
  either invokes a command only that app grants or describes a
  `subshell-server` only that app manages. Taking the title-bar branch inside
  Subshell Client would leave a window with no title bar and no drag strip —
  unmovable.
- **`isDesktop()` — "am I inside EITHER shell".** Exactly two surfaces use it,
  and both work in both apps: the rail's **Open in browser** row
  (`components/app-sidebar.tsx`, last in the `<nav>`) and the same item in
  `components/subshell-actions-menu.tsx` (`sidebar: true`, so the rail's
  right-click menu carries it too).

**The footer's app-update row is a server-desktop surface, and it is mounted
where that is structural** (spec 2026-09-17 §5.3):
`components/desktop/desktop-app-update-row.tsx`, read via
`hooks/use-desktop-app-update.ts`, rides `desktop-sidebar.tsx`'s `footerEnd`
above `UserMenu` — the rail `__root.tsx` only renders on `isServerDesktop()`, so
neither Subshell Client nor a browser can reach it. `desktop_app_update` reports
THAT app's version and is granted to that window alone. It shows and never
applies: [Update] raises the assistant at `app-update`. A shell predating the
command answers nothing and the row is simply absent — as is every claim of
being "up to date", since `availableVersion: null` means "no known update", not
"checked and current". The × is `sessionStorage` keyed to the dismissed VERSION
(`lib/desktop-app-update.ts`), so the next release re-shows the row with no
expiry logic to drift.

**"Open in browser" sends a PATH and never a URL.** `desktopInvoke(
"desktop_open_in_browser", { path })` — the forgiving variant, so an older
shell that knows no such command simply does nothing. Rust joins the path onto
the window's OWN origin (the server app's loopback origin; the client app's
pinned plane), and refuses anything that could name a host. The rail sends
`location.pathname + location.searchStr`; the menu sends `/subshells/<id>`.

Two things the person will notice, and neither is something this feature
tries to fix:

- **They sign in again over there.** Cookies do not cross from the webview to
  the browser — different cookie jars, same origin or not — so the browser
  arrives signed out.
- **Subshell Server opens its LOOPBACK origin**, because that is the only
  origin its window is ever pointed at. Passkeys are bound to the configured
  `APP_BASE_URL` host (better-auth derives the rpID from the static baseURL,
  not the request host), so a passkey works on that address only if
  `APP_BASE_URL` is the loopback one.

## Networking: one card that is a state machine (spec 2026-09-15)

`/settings/networking` and the first-run step both render ONE component,
`components/networking/network-plugin-card.tsx`, and that is deliberate: the
six states a network walks (`not-installed` → `daemon-down` →
`needs-privilege` → `needs-login` → `joined` → `published`, plus unsupported
and disabled, which short-circuit before any of them) are a sequence a person
passes once, and a second implementation of it would be a second place for
"what can I do from here" to be answered differently on two pages met minutes
apart. The wizard step passes `compact`, which changes the FRAME and never the
acts — it drops card chrome, the description, the supervisor line and every
non-required settings field, because hiding a required one would leave a
Connect button nothing on screen could satisfy.

**The page itself is two cards and a form, since 2026-09-17.** The
`AddressesCard` moved in from `/settings/service` — where this server listens
and which addresses a browser may use is the same question this page answers,
asked of config.env — so its 60 s `useServerDeployment` poll now feeds the
card alone (the card's save writes the fresh view into that cache itself,
which is why the cadence did not move with the card; the "This server's
address" summary line the read used to feed is GONE — the card states the
value in its field, saved-vs-running included), and the page mounts
`useServerRestart` + `useAdminStatus` for its restart half. Below it sits ONE
grouped **Networks** card holding the installed plugins as collapsed rows —
`NetworkRow`'s `full` prop became `body="compact"|"full"` because the group
drew the distinction the per-network card frame used to: two surfaces, one
flat row frame, different bodies. The card is UNCONDITIONAL — a failed
deployment read renders it with the failure and a Retry inside rather than
losing the page's main form, as it first did (review, 2026-09-17) — and an
answered-empty networks list answers in place ("No networks installed yet");
`AddNetworkCard` below carries the install affordance.

Three rules the card keeps, each with a defect behind it:

- **The plugin owns its copy.** Hints, labels and step text render verbatim.
  What this page owns is the shape, and the consequences that are the SERVER's
  rather than the network's — what a non-secure-context address costs, that
`subshell-server backup` does not include a plugin secret. Publishing moves
  no boot-time identity and writes no config: the base URL is the Addresses
  card's field — that card moved onto THIS page from `/settings/service` on
  2026-09-17, the one config.env writer here, saving through the same
  `PATCH /api/admin/server/config` the Service page used to host it — and
  the server's allowlist is a LIVE registry — its own local
  origins ∪ the Addresses card's `TRUSTED_ORIGINS` extras (consulted on every
  request) ∪ every ENABLED network plugin's addresses (a `private` network
  from `joined` up; a `public-with-gate` one only while published). So a join
  to a tailnet is enough for a phone to sign in, a publish trusts its
  addresses the moment the plugin reports them, and an unpublish, a leave or a
  Disable takes back exactly what THAT act ends trusting — now, not at a
  restart (2026-09-16; the restart notice, `config-write-outcome.tsx` and the
  card's `useServerRestart` went with the config write they described): a
  gated unpublish its published set, a leave or a Disable everything the
  plugin held, and a private unpublish NOTHING — membership is what trusts a
  private network's addresses, so those stay until a leave or a Disable ends
  the membership (ruling R-D-lite v2: the wire's `origins` is that per-act
  diff, which is why the result line never overstates what stopped). For the
  implicit kind the JOIN is the publish: the join route records it and its
  `done` frame lands on `published`, which is what the card keys its
  announcement on. The result grammar is `lib/network-result-copy.ts` —
  outcome first, no key named, present tense only — pinned in
  `lib/__tests__/`. The card's Disable is `useSetPluginEnabled` from
  `use-instance-plugins.ts`, the same `PATCH /api/plugins/:id` Settings →
  Plugins toggles (the server unpublishes first and 409s if it cannot); it
  confirms only when there are addresses to name, and a disabled row collapses
  to one line plus Enable. The `compact` frame carries no Disable — first run
  is not where someone toggles plugins.
- **Nothing privileged is ever a button**, including the numbered install steps.
  Same rule as the wizard's tmux screen (`components/setup/tmux-step.tsx`):
  this server has no terminal to answer a password prompt. Numbering runs only
  over hints that carry a COMMAND, so a plugin's explanatory sentence is not
  rendered as an instruction to perform.
- **A refusal is an ANSWER.** A publish returning `ok:false` with a `refused`
  hint renders inline where the button was, with no alert role — the server
  worked correctly and said why not.

`hooks/use-network.ts` holds the query and six mutations; the three streaming
ones (install, join, publish) reuse `readInstallStream` from
`use-install-agent.ts` rather than a second NDJSON reader. Every act that
changes what is trusted — publish, unpublish, leave, and join — invalidates
`PUBLIC_SETTINGS_QUERY_KEY`, because `GET /api/settings/public → trustedOrigins`
is the effective allowlist and the mobile dialog and the setup checklist read
it; `useSetPluginEnabled` does the same, plus `NETWORK_QUERY_KEY`. Every act
goes through the card's `begin()`, which resets ALL the mutations: a result
outlives the state it describes, so a publish announcement survived the
unpublish that undid it until that was true.

`types/network.ts` is a HAND-WRITTEN mirror of `apps/server/api/src/api/network/schemas.ts`.
Elysia strips fields a schema does not declare, so a mismatch is silent in
exactly the way `lib/split-workspace-refusal.ts` records — check both when you
touch either.

**A network plugin must never be launchable.** Every picker filters
`type === "agent-harness"` positively rather than `!== "terminal"`
(`lib/subshell-compat.tsx`, and mobile's `lib/agent-default.ts`). That is the
whole type audit, and reverting either filter fails a test.

**The wizard's optional steps carry ONE primary button, and its label names
what the press actually IS** (operator's call, 2026-09-18): "Continue" only
when the step has something to continue with — a joined or published network
(`isNetworkUsable`, deliberately narrower than the `hasStarted` sort key: an
installed-but-signed-out daemon still leads the list and still says skip), or
a detected agent — and "Skip for now" otherwise. The network step used to
ship a ghost skip beside an unconditional Continue, two buttons for the one
`goNext` they both ran and a label that promised a continuation on a machine
joined to nothing. Unknown reads as the skip label, the OPPOSITE polarity
from `lib/node-enrollment.ts`, which defaults unknown to allowed — there an
unknown hid a control that works; here it would mislabel an action a failed
check cannot vouch for, and skipping must work exactly when the check cannot
speak. **The tmux step is not one of the optional steps — it GATES**
(operator's ruling, 2026-09-18, deliberately reversing spec 2026-09-15
§ 5.1's non-blocking choice): its button always reads "Continue" and stays
disabled until the admin-status read reports a `tmuxPath`, because skipping
tmux just moves the refusal from the step to the launch button without saving
anyone a step; a failed read therefore grows the body's ErrorBanner + Retry —
a gate with no way to answer is the trap § 5.1 was written to avoid, inverted.
The launch step keeps a real ghost Skip because there Skip and Start are
different acts — the one case where two buttons are honest.

## Talking to the backend

All backend traffic goes through shared helpers; the only raw `fetch` calls in
components are the better-auth sign-in/sign-out posts:

- JSON endpoints: `apiFetch<T>` / `apiPost<T>` from `src/lib/api.ts` (cookie
  credentials included; failures throw `ApiError` with a numeric `status`).
- Current user: `getSessionUser` / `useCurrentUser` in `src/lib/auth.ts` hit the
  better-auth `get-session` endpoint through `apiFetch`. Sign-in (`routes/login.tsx`)
  and sign-out (`components/app-sidebar.tsx`) POST straight to better-auth's
  `/api/auth/*` endpoints.
- Terminal attach: `src/lib/use-subshell-ws.ts` — a short-lived (30 s) single-use
  WS token minted over REST, then the `/ws` connection. Never put the subshell
  bearer token in a URL.
- Uploads/streaming: the fetch paths in `src/lib/subshell-uploads.ts` (driven by
  `src/hooks/use-terminal-uploads.ts`).

## Testing

`bun test` with `src/test-setup.ts` preloaded (via `bunfig.toml`; it registers
happy-dom globals for component tests). Component and
lib tests live in `__tests__/` next to the code (`components/__tests__/`,
`lib/__tests__/`). Tests are pure-function and component-level; browser-level
end-to-end coverage lives in the repo-root `e2e/` workspace (Playwright) —
`bun run test:e2e` from the repo root boots its own backend and needs a real
tmux + a one-time `bunx playwright install chromium`.

## Drafts and the split flow (spec 2026-09-14)

A workspace can begin on a subshell page: **Split** (`components/split-subshell-button.tsx`)
opens the same add-subshell dialog the dock uses, creates a DRAFT workspace
around the current subshell (`POST /api/workspaces { draft: true, subshellId }`)
and navigates to `/workspaces/$id?add=<subshellId>&dir=<direction>`. The dock
and the tab strip consume that intent once dockview is ready, through their
ordinary `handleAdd`, then strip the params — so the first split and every later
add run one code path, and the picker's direction is honoured.

Three rules keep a draft honest, and each is load-bearing:

- **Drafts are absent from `GET /api/workspaces`**, so `/workspaces`, the
  sidebar recents and the cards need no draft awareness. The only read that
  returns them is `?subshellId=`, which feeds the subshell page's workspace
  control (`components/subshell-workspace-link.tsx`). A subshell can sit on
  any number of workspaces, so that control has two shapes, decided by the
  pure `workspaceLinkView`: ONE is a direct link naming it, SEVERAL is
  "In N workspaces" opening a menu of all of them. Drafts lead and read
  "Unsaved workspace" rather than their placeholder name, and the sort is
  stable so rows the server already ordered by recency keep that order when
  their timestamps tie — which they do, a split writing several rows inside
  one millisecond. Menu rows are real links (`render={<Link/>}` +
  `nativeButton={false}`), so middle-click still works.
- **A draft below two panes is discarded** — server-side when a pane is removed
  (`removePane` resolves `{ workspaceDeleted }`), and client-side on read by
  `hooks/use-discard-thin-draft.ts`, which sends the person back to the
  remaining subshell. That hook is GUARDED by the `?add=` intent: a freshly
  created draft is one pane for as long as its second pane is in flight, and the
  presentations strip the params only after the refetch shows both — and only
  when the add actually LANDED. A failed add keeps the params, so the guard
  stays engaged and the error banner stays on screen instead of the draft
  being discarded from under it with nothing said (review, 2026-09-14). Break
  that ordering and every split discards itself.
- **`useInvalidateWorkspaces` also invalidates the per-subshell membership
  query**, so a link to a draft never outlives the draft.
- **The create response is CHECKED, not trusted** (`lib/split-workspace-refusal.ts`).
  Elysia strips body fields a schema does not declare, so a server older than
  this page answers the split with a plain 200 and silently drops both `draft`
  and `subshellId` — landing the person on a workspace missing the subshell
  they split from. That happened on 2026-09-14 against a dev SPA proxying to an
  installed binary built hours earlier. The button now refuses a response that
  is not `{ draft: true, subshellCount: 1 }`, deletes the empty workspace such
  a server did create, and says the server is behind.

`WorkspaceHeader` renders a draft with a static "Unsaved workspace" title plus
**Save workspace…** (`PUT /:id { name, draft: false }` — the one transition) and
**Discard**; the presentation supplies `onDiscarded` so a discard lands on the
active pane's subshell. Copy says "unsaved workspace"; code says `draft`.

## Terminal gotchas

Workspace panes hold live xterm.js terminals inside dockview panels. A dockview
panel remount disposes its terminal, closes the WS, and forces a history
replay — every panel must keep `renderer: "always"`, which is what keeps the
DOM alive when a panel is hidden.

### Upgrading `dockview-react`

dockview must **not** remount a panel's content when panels are moved or split.
The last known-good version is 8.2.0, verified by hand, and nothing automated
covers the promise. After any `dockview-react` upgrade, re-run the probe:

1. Open a workspace with two or more panes and open DevTools → Network → WS.
2. Drag a pane onto another pane's edge to split, and drag a tab between groups.
3. **No new `/ws` connection may appear, and no existing one may close.**

If one does, the upgrade is not safe: pin back to the last known-good version.

### Swipe navigation

`useSwipeNav` publishes `data-swipe-nav="ready"|"idle"` on the zone it binds
to, from the same effect that governs binding. It exists for the e2e suite,
whose difficulty with this feature was that nothing observable said when a
swipe could work: the gesture is only bound once the subshell LIST has loaded
and neighbours exist, the terminal mounts well before that, and a swipe
dispatched in between is silently a no-op — the page just does not move, with
no error anywhere. Waiting on `.xterm`, and later on the list response, both
still raced (a response arriving is not the app having rendered from it).
Anything driving a swipe should wait for this attribute; it is the fact
itself rather than a proxy for it.

### Several devices, one pane

A tmux pane has ONE grid, so every attached viewer constrains it. The rule
itself lives in `@internal/subshell-protocol` (`shared-geometry.ts`) so the
server can APPLY it and the browser can EXPLAIN it from one definition:
smallest visible viewer wins, hidden viewers drop out, a pin overrides both.
`decideSharedGrid` returns the grid plus the viewer ids holding each axis;
`describeDevices` (also in the protocol package, beside the rule it explains — the phone needs it too) turns that into the rows `<SubshellDevices>` renders —
in the subshell header, and floated over a workspace pane's top-right corner
(dockview owns that panel's frame, and a row of our own would cost every pane
vertical space for a control that is absent whenever one device is attached).

Whether the viewer may CHANGE the sizing is read off the presence frame's own
`canInput`, never passed in: a workspace pane has no access field to hand, and
any caller-side copy can disagree with the server that enforces it.

Two traps on this path, both invisible with a single viewer and both hit for
real (2026-09-04):

- **Do not report `term.cols`/`term.rows` as this client's size.** The
  container is pinned to the grid the server announced, so the terminal's own
  grid is an ECHO of the server's answer. Sending it back makes this viewer
  claim it can show no more than the smallest one — after which the pane never
  grows back when that viewer leaves. The client's only size statement is
  `measureCapacity()`, measured from the OUTER (pane) box.
  A null measurement is NOT a fallback to the terminal's grid either: it
  means "could not measure right now" (a sash mid-drag), and answering it with
  `term.cols` is the same echo by another route. A pinning caller stays SILENT
  until it can measure; the next observer tick reports the real number.
- **`&device=` on the attach URL is load-bearing.** Without it every row of
  everyone's Devices list reads "Unnamed device" and the list explains
  nothing. `lib/device-name.ts` derives it from the User-Agent and honours a
  per-device localStorage override. `&hidden=` rides the URL for a different
  reason: the on-open `visibility` frame races the server's attach and is
  dropped when it wins, and nothing re-sends it until the tab is shown.
- **Decide the letterbox font from the size the user CHOSE, never from the
  one this function last left behind.** Testing overflow against an
  already-shrunken cell says "it fits" — which is only true because it was
  shrunk — so the font flapped between the two on alternate frames. And cell
  metrics read back immediately after assigning `options.fontSize` may be
  stale, so anything that changes the font re-runs on the next frame
  (`applyLetterboxSettled`).
