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

**The admin surface is six pages behind one collapsible group** (spec
2026-09-11 grouped-navigation): General (`/settings`), Users, API keys,
Plugins, Status and Audit log, listed in the rail under **Server Settings**
and gated as a WHOLE — a member's rail lists none of them, `/users` included,
though that route stays reachable by URL for everyone because the sharing
picker reads the same roster. Two of the six are read-only: `/settings` is
where an admin CHANGES the instance, while Status and `/settings/audit` are
where they see what it currently IS and what has happened to it.

`routes/settings_.status.tsx` (`/settings/status`, components in
`components/admin-status/`, data in `hooks/use-admin-status.ts`) is the model
for the gate the others copy: server-derived `viewerIsAdmin`, with `undefined`
counting as NOT admin — the query is `enabled`-gated on it so a non-admin
mount fires no doomed 403. `/settings/audit` is the same shape
(`components/settings/audit-trail-card.tsx`), with the route owning the gate
so the card's query can be unconditional; its `staleTime: 0` is load-bearing,
since mounting the page is now the only thing that refreshes the trail.

**The launch form asks nothing it cannot answer.** `new-subshell-form.tsx`
filters its node options on the server's own `canLaunch` (never a re-derived
rule), hides the Machine field when the sole target is the control-plane host —
a single AGENT node keeps it, because once a second machine exists the answer
is news — and replaces itself with `no-launch-targets.tsx` when nothing is
launchable. That empty state offers both routes out and gates only the one it
must: adding a node needs a signed-in cookie, so that button is always there,
while switching the host back on is a manage act and appears only when the
server says this viewer manages it. Both rules are pure exports
(`hideMachineField`, `launchableNodes`) tested without opening a dropdown.

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
is about the MACHINE: which of the two modes it is in, and — below both, a
settings pane's own shape — whether it starts at login. That switch is genuinely
dependent on the background mode (the route 409s under the app, and there is no
definition to arm), but the dependency is carried by a disabled reason naming
the other mechanism, not by nesting: indenting it under the first radio wedged a
control between the two choices so they stopped reading as a pair. They were one card, and it read wrong —
"Restart server" and "change what supervises this machine from now on" sat as
sibling buttons, the second a bare "Run with the app instead…" that named no
alternative and explained nothing.

`SupervisionCard` shows **both modes in every client**, current one marked. A
browser on the LAN and a phone cannot change it — the radios render disabled
with a line naming where it is changed — but they now learn what the machine
is doing, which the old card never told anyone. **The radio IS the choice, and the confirmation is a dialog on this page.**
Clicking the unselected mode opens `SupervisionDialog`, which lists what the
switch does and calls `desktop_set_supervision` through the desktop bridge
(`useSetSupervision`) — no assistant window (operator's call, 2026-09-12;
`docs/security.md` carries the accounting for granting that command to the
SPA window). The radio shows the MACHINE, not the pick — it does not move until
the machine reports the change — so dismissing the dialog cannot leave the
card claiming a mode that never took effect.

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

**The mode and the login switch are two axes, and the copy has to keep them
apart.** The radio answers WHO runs the server; the switch answers whether it
comes back BY ITSELF next time you log in. Both managers run the server inside
the user's own login session, so it stops at logout either way — which is why
"keeps it running whether or not the app is open" was misread as covering
logins and now reads "runs it, whether or not Subshell Server is open", with
the switch saying what it adds ("nothing brings it back after you log out or
restart"). The desktop assistant's two screens carry the same distinction.

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

The Nodes UI (`routes/nodes.tsx`, `routes/nodes_.$id.tsx`, components grouped in
`components/nodes/`, data in `hooks/use-nodes.ts` + `use-node-shares.ts`): the
Add-node dialog renders the install one-liner from `GET /api/settings/public →
appBaseUrl` — NOT `window.location.origin` (fallback only while settings load) —
so the command always names the same SERVER the backend bakes into the served
`/install.sh`; a loopback `appBaseUrl` renders the amber "remote node cannot
dial this machine" hint. The dialog also reads `nodeArtifactTargets` — the
triples the server actually serves — and names the missing ones (in step 1,
BEFORE a single-use key is minted, and in step 2 with a copyable
`subshell enroll` fallback): a binary-only server install publishes no agent
binaries until `release:node` runs, and the one-liner 404s on every machine
until then. The field being ABSENT (older server behind a cached PWA) stays
silent; the query still loading or errored shows a "could not check" line
instead — no verdict without data. Opening the dialog refetches so a just-
published artifact set is visible at once.

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
