# Server web AGENTS.md

Documentation for the React SPA the control plane serves (`apps/server/web`,
`@internal/server-web`). It is the SERVER's web UI and nothing else's, which
is what its place in the tree says: it sits beside `apps/server/api`, which
builds it into its binary and serves it. The two desktop apps carry their own
small bundled pages under `<app>/ui/` and share nothing with this one.

**Styling follows `docs/design-system.md`** (five type roles, two weights,
shadcn colour names), and `bun run lint:design` fails on a literal size,
weight or colour outside the token file. Pick a role, never a number.

**Form sections use the shared `FormSectionTitle`**, with the approved A3
trailing rule. Preserve fieldset legends and field labels as distinct roles.
See [the form hierarchy and audit](docs/form-sections.md) before changing form
section styling.

**Topic deep dives live in `apps/server/web/docs/`, one file per area.** This
file keeps what constrains an edit anywhere in the app; each moved section
leaves a routing line naming the file to read first. The moved text is
verbatim: nothing was dropped or reworded in transit.

**Every table belongs in a card**, including CSS-grid tables. Use the shared
`Card` component; a containing page card counts, so do not nest cards. See
[the dashboard design rules](../../../docs/design-system.md#dashboard-pages-and-tables)
for card grouping, compact rows, responsive columns, disclosures, and menus.
Prompts and prompt stacks use card-contained tables; their name buttons expand the body or members,
and membership disclosures remain table detail rows.

## URLs

- Dev server: http://localhost:5174 (Vite), which proxies `/api` and `/ws` to the
  backend at 127.0.0.1:3080 so cookies and WS auth just work on one origin.
  Set `DEV_API_ORIGIN` to use an isolated backend instead, for example
  `DEV_API_ORIGIN=http://127.0.0.1:3199 bun run dev`. Use this hot-reload URL
  for interactive UI testing so edits appear without rebuilding or refreshing.
  For a development reverse proxy, set `DEV_ALLOWED_HOSTS` to its hostname and
  `DEV_ALLOWED_ORIGINS` to its exact external origin (for example,
  `https://test.example.com`). Only those explicit origins are translated to
  the backend’s trusted localhost development origin.
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

Dashboard content uses `DashboardPage` for the same fluid width and margins
as Settings, including loading and error states. Terminal and workspace
canvases retain their full-height layouts.

Dashboard list searches use server-side query parameters, with 300 ms text
input debounce (`useDebouncedValue`). Filtered cache entries are children of the
resource key; they never replace the complete list. Select filters apply
immediately. Forward the query's abort signal to fetch and keep every filter in
the cache key, so an older response cannot replace the current search. Live
updates invalidate active filtered queries without replacing the complete-list
cache with a subset. Keep loading, errors, and zero matches distinct. Use
`ListLoadError` for compact retry states in sidebars and pickers, with retry
recovering every failed query the view depends on. Use `LIST_SEARCH_MAX` for
input bounds; the API independently enforces them. Presentation rules remain in
[the design guide](../../../docs/design-system.md#dashboard-pages-and-tables).

Route files stay thin: URL state + handlers + composition; data logic goes in
`hooks/`, reusable UI in `components/`, shared types/constants in `lib/`.

**The node-admin surface does NOT live here: it is `@internal/node-admin`
(Apache-2.0).** The six node cards (runtime, service, log, maintenance, control
plane, allowed-dirs), the seven UI primitives they render, `lib/api` +
`lib/confirm`, `lib/node-maintenance` + `lib/node-confirmations`, the
`persistence()` half of what was `lib/supervision.ts`, `relativeElapsed`, the
detail hooks, and `types/node.ts` moved to `packages/node-admin` on 2026-09-19
so the node's own loopback dashboard can render the same machine in the same
words; this app imports them from the package. The move was also a deliberate
AGPL→Apache relicense (root AGENTS.md: "Decide it, don't discover it"). What
stays plane-only: the harness card, sharing, key rotation, setup keys,
`DirectoryPickerInput`, and `lib/supervision.ts`'s SUPERVISION half. The
cards' plane-side fallout reaches the package through props
(`onMaintenanceChanged`, `renderEditor`/`onDirsSaved`), never the other way.

**The sidebar (`components/app-sidebar.tsx` + `components/sidebar/`) is more
than nav, and its rules reach the whole app.** Status words and their
precedence live once in `lib/subshell-indicator.ts`, whose only renderer is
`SubshellDot` (`components/subshell-dot.tsx`). Subshell lists everywhere are
kept current by ONE live socket (`hooks/use-live-subshells-feed.tsx`, mounted
in `__root.tsx` signed-in-only), read via `useSubshellsList`/
`useLiveSubshells`, never by opening a second one. "Drag a session into a
workspace" speaks exactly one payload (`lib/subshell-dnd.ts`): handlers react
ONLY to its MIME, which is what keeps xterm's file-drop and dockview's
tab-drag untouched. Every label that names a machine reads `node.name`, never
the id (root AGENTS.md: nothing rendered derives from the id).
**Working on the sidebar (grouping, group-collapse prefs, row tooltips, the
Needs Attention spotlight): read apps/server/web/docs/sidebar.md first.**

**The live feed has no cadence, and that is load-bearing for every reader.**
One snapshot at connect, then a frame only when something changed: a snapshot
must not clobber a newer event; a broadcast carries no per-viewer `access`
stamp (the client keeps the access it holds); pane previews are PULLED by the
surfaces that draw them. The feed writes exactly `SUBSHELLS_QUERY_KEY`, plus
the per-id `["subshell", id]` entry only when it already exists; removals and
access changes INVALIDATE it instead, and a removal also INVALIDATES the
`["workspace"]` detail (a close cascades the pane rows; the dock tiles render
from that read and nothing else wakes it), and a rename invalidates the same
detail read, so an open dock tab re-titles itself instead of holding the old
name until remount. Pages must follow the CACHE, not the
feed's own copy; activity derives from `lastOutputAt` against a clock
(`hooks/use-clock-tick.ts`), and any NEW surface rendering `subshellIndicator`
needs its own tick.
**Working on anything that reads or writes subshell state: read apps/server/web/docs/live-feed.md first.**

**The subshells list (`/subshells` since the workspace-first move of
2026-10-17) reads its state as a dot and segments by machine** (tiles and
the list share ONE `SubshellSection` model; the machine combobox is ALWAYS
drawn), and two instance-wide gates decide what may launch anywhere:
`allow_server_subshells` refuses every new launch and restart on the host
non-destructively (running panes finish; the `local` row stays visible), and
`lockdown` stops every running subshell everywhere and 403s every create and
restart before any machine is chosen: turning it ON is typed-confirmed, a
re-submitted ON is INERT, and `components/lockdown-banner.tsx` tells everyone
signed-in, mounted in `__root`.
**Working on the subshells list, the landing `/`, the launch pickers, or these gates: read apps/server/web/docs/home-launch-guidance.md and apps/server/web/docs/workspace-first.md first.**

**The sidebar is one panel with its section bar docked at the bottom.** The
route selects Workspaces, Settings, Subshell for Mobile, or Account, and the
panel's section cells ride a centered icon-button row at its bottom: Workspaces
and Settings are links, Subshell for Mobile opens the PWA install dialog, and
Account is the profile card's trigger (plus "Open in browser" as the bar's last
button, desktop shells only). There is no icon rail, no logo button, and no
panel collapse. Workspaces combines the selected
workspace's panes with a grouped **Subshells** section;
members are excluded from that lower list. Clicking another subshell adds it
as a tab. Dragging between the lists adds or removes membership, with centered
labels and no success toast. Removing the last pane retires the workspace;
subshell processes stay running, unfiled. Row menus provide the same
membership actions.
Subshell dashboard remains in the grouping dropdown’s actions menu and uses this same
sidebar. Each bar button navigates to its section's remembered page, the
active one too, except a Workspaces click inside `/workspaces/$id`, which
stays a no-op. Settings shows personal pages and all eleven
Server Settings pages, with the whole admin group gated by server-derived
`viewerIsAdmin === true`. Account contains Profile, Preferences, Feedback, About, and Sign out as direct
sidebar items, with identity, server details, and admin update notices in a plain footer. `/mobile?platform=apple|android|browser` shares its
installation content with the mobile dialog. On phones, a root-owned drawer
survives section changes and closes when a subsection or pane is selected.

**Working on Server Settings navigation or its gating: read apps/server/web/docs/settings-navigation.md first**, plus the per-page dive named below.

**`/settings/updates` is ONE Components table**, not three cards (name /
running / newest / act; the row order desktop apps → Server → Nodes is pinned
by `updates-table.test.tsx`), and everything that is not a cell is a
`col-span-full` detail line inside its row. Inside Subshell Server the app row
and the Server row FOLD into ONE control that raises the assistant; a browser
keeps both rows. A node update's last act lands AFTER its 202, so
`node-rows.tsx` owns a bounded watcher for the return.
**Working on this page: read apps/server/web/docs/settings-updates.md first.**

**There is ONE new-account form** (`components/account/new-account-fields.tsx`,
shared by the first-run wizard and the Add user dialog) **and the login page
paints its providers from the anonymous read**: `GET /api/settings/instance`'s
`providers` list, with `emailSignIn` gating the password form AND the passkey
button. `lib/sign-in-diagnosis.ts` is the ONLY mapper of sign-in outcomes,
pure and tested; `pending_approval` navigates to `/pending`, and pending and
rejected are indistinguishable from the visitor's side. Button labels wear the
provider's NAME, because same-kind rows are legal.
**Working on sign-in or account creation: read apps/server/web/docs/settings-account-login.md first.**

**Status and Logs are the two read-only admin pages.** `/settings/status`
mounts `useServerDeployment` at **60 s**, not the hook's 5 s default: each
poll of `GET /api/admin/server` is a `Bun.spawnSync` stall for the whole
server, so a page reading only process-fixed facts must not inherit the
Service page's cadence; the System tab of `/settings/logs` gates the same
read on tab activity for that reason. `/settings/logs` is one tabbed page
(`?tab=audit`; ABSENCE is System) whose `AuditTrailCard` is KEYSET-paginated
on a `(createdAt, id)` PAIR, because two events can share a millisecond.
**Working on either page: read apps/server/web/docs/settings-status-logs.md first.**

**A form with required input runs through the substrate, `src/lib/form.ts`
(spec 2026-09-29).** One structural validator (a zod schema, or the existing
field-problem function where rules shadow the server's) feeds BOTH the submit
button's `disabled` (`useSubmitDisabled`) and the handler's guard, so they
cannot drift; sentences show once a field is touched and never while the caret
is in the box. A new hand-rolled `disabled={...}` on a required form is the
defect this replaces.
**Working on any form's submit gating or validation: read
apps/server/web/docs/form-substrate.md first.**

**The launch form asks Agent → Preset → Node → Working directory and asks
nothing it cannot answer.** The dialog opens on your last launch (node and
directory pre-filled from the newest prior subshell), and choosing a preset
prefills the node, directory, and prompt it names (spec
2026-09-29-preset-launch-fields; a hint, every field stays editable); the
auto-default selector (`launchTemplateFromList`) and `defaultAgentId`'s recent
tier share one `sortByCreation` head, so they cannot disagree about which row
is recent. A directory is a claim about ONE machine:
changing Machine clears `workingDir` and re-arms the per-machine seed, and the
folder picker is machine-scoped end to end. Node options filter on the
server's own `canLaunch` (never a re-derived rule). Two kinds of unlaunchable
are shown differently on purpose: a host narrowed by its shares VANISHES; a
node in maintenance is KEPT and greyed with the reason. A presetless launch
omits `presetId`: absence, never null.
**Working on the launch form, presets, the folder picker, or no-launch states:
read apps/server/web/docs/launch-form-picker.md first.**

**A preset's command renders by ONE quoting rule (operator ruling
2026-09-25).** Names print as names: env keys and flag tokens are NEVER
quoted, and the command prints bare (it gains quotes only if it could not
be spelled bare at a prompt, identically in both renderers); an env value takes quotes only where a shell would
split or expand it (double, or single for `$`/backtick/`!`: `MODEL="Qwen 3.8
Flash Next"`, `H='$HOME'`, `URL=https://x.dev`); a flag's CLI-arg value
prints VERBATIM, because a quote inside a CLI argument is data the person
typed, never quoting the renderer adds; a flag without a value contributes no
token, not an `''`. The two renderers, `presetFormToCommand` (the editor's
command panel, multi-line) and `presetLaunchCommand`
(`lib/launch-command.ts`, the `/presets` row preview, single-line), share
`shellQuote` in `lib/preset-command.ts` and must keep printing the same
words: a second quotifier is how they diverged once (`quotePosix` single-
quoted everything, deleted with the fix).

**`/settings/service` is two cards, because they are two kinds of thing**:
`ServiceCard` is about the running PROCESS, `SupervisionCard` about the
MACHINE, and `isServerDesktop()` is the seam: inside Subshell Server the
supervision card is a CHOICE (a confirmation dialog, then a `settling` phase;
the radio shows the MACHINE, not the pick), in a browser it is a FACT and at
most one fix (`persistence()`, which a node's Runtime card shares in the same
words). The model is `lib/supervision.ts`, not the card. On Linux there is a
THIRD axis, lingering (`service.linger`): an ENABLED `systemd --user` unit
still dies at logout without it. The mode switch cannot be a route: the act
needs an actor that outlives the server, so the desktop app performs it over
IPC; start-at-login IS a route, because it changes nothing running.
**Working on service or supervision UI: read apps/server/web/docs/service-supervision.md first.**

**A node's page is Overview + two daemon sections, and the rules live on the
Overview**: `managesNodeSections` hides the Service and Logs tabs AND gates
their deep links (hiding a link never gated a URL), and the Configuration tab
is gone: the allowlist card renders on the Overview (the Server-URL card left
it 2026-10-09; the plane cannot see where a node dials, so repointing is the
CLI or the node's own dashboard). The harness card's Re-check gate is a
DIFFERENT rule; do not collapse them.
Maintenance is one flag confirmed with a named `runningSubshells` count, and
both callers must surface the `failed` array. A refused kill must not read
as a quiet machine.
**Working on a node's page: read apps/server/web/docs/node-page.md first.**

**Whether "Add node" is offered is `lib/node-enrollment.ts`, not an
expression at each call site**: an unanswered settings read counts as ALLOWED
(matching the server's absent-row default), and the button is ALWAYS DRAWN,
disabled where it does not apply. **The Add-node dialog is ONE screen**: until
Generate is pressed NO KEY EXISTS, and on the terminal panel the key lives
inside a command and never outside one; the shared address picker is
`lib/install-addresses.ts`. `components/nodes/node-key-setup.tsx` is the
shared fields component, and `setup-keys-section.tsx` shows the caller's own
keys WITH their text (owner-scoped, cookie-only) and offers `Setup` on the
`unused` rows only.
**Working on enrollment, the Add-node dialog, or setup keys: read apps/server/web/docs/add-node-dialog.md first.**

## Subshell for Mobile (the PWA install dialog)

`components/mobile-install-dialog.tsx` is UNGATED, desktop shells included,
and the section bar's Subshell for Mobile cell opens it (it is not a route):
its payload is a QR code, read by a DIFFERENT device. Its first control is an
address picker built from `lib/install-addresses.ts`; loopback rows are
DROPPED in `installAddresses`, not labelled here. `trustedOrigins` on
`GET /api/settings/public` is the EFFECTIVE allowlist: local origins ∪
derived LAN interfaces ∪ the Addresses card's extras ∪ every enabled network
plugin's addresses, re-asked of the kernel by the read itself. The QR's plate
is `bg-white` unconditionally, because a QR is read optically and dark
modules on a dark surface do not scan in either theme.
**Working on this dialog or the shared address list: read apps/server/web/docs/pwa-install-dialog.md first.**

## This SPA meets TWO desktop shells, and "desktop" is two questions

`lib/desktop.ts` parses a `SubshellDesktop/…` or `SubshellClient/…` User-Agent
suffix, which each shell's `windows.rs` sets on its remote window. The marker is
a UA suffix rather than an injected script or an IPC handshake because it is
present on the FIRST request, readable before React mounts (so there is no flash
of the wrong chrome), and survives the hard `window.location.href` navigations
at sign-out and after sign-in.

**Two predicates, and picking the wrong one is a control that cannot work:**

- **`isServerDesktop()`: "am I inside Subshell Server".** What every gate that
  predates 2026-09-14 means. It switches on the overlay title bar and its drag
  strip (`useDesktopShellReady` in `routes/__root.tsx`), the server pill, native
  notifications, and the update, reset and supervision surfaces. Each of those
  either invokes a command only that app grants or describes a
  `subshell-server` only that app manages. Taking the title-bar branch inside
  Subshell Client would leave a window with no title bar and no drag strip,
  unmovable.
- **`isDesktop()`: "am I inside EITHER shell".** Exactly two surfaces use it,
  and both work in both apps: the section bar's **Open in browser** button
  (`components/app-sidebar.tsx`, last in the `<nav>`) and the same item in
  `components/subshell-actions-menu.tsx` (`sidebar: true`, so the sidebar's
  right-click menu carries it too).

**The footer's app-update row is a server-desktop surface, and it is mounted
where that is structural** (spec 2026-09-17 §5.3):
`components/desktop/desktop-app-update-row.tsx`, read via
`hooks/use-desktop-app-update.ts`, rides `desktop-sidebar.tsx`'s `footerEnd`
below the bar's `UserMenu` cell: the desktop sidebar `__root.tsx` only renders
on `isServerDesktop()`, so
neither Subshell Client nor a browser can reach it. `desktop_app_update` reports
THAT app's version and is granted to that window alone. It shows and never
applies: [Update] raises the assistant at `app-update`. A shell predating the
command answers nothing and the row is simply absent, as is every claim of
being "up to date", since `availableVersion: null` means "no known update", not
"checked and current". The × is `sessionStorage` keyed to the dismissed VERSION
(`lib/desktop-app-update.ts`), so the next release re-shows the row with no
expiry logic to drift.

**"Open in browser" sends a PATH and never a URL.** `desktopInvoke(
"desktop_open_in_browser", { path })`, the forgiving variant, so an older
shell that knows no such command simply does nothing. Rust joins the path onto
the window's OWN origin (the server app's loopback origin; the client app's
pinned plane), and refuses anything that could name a host. The bar sends
`location.pathname + location.searchStr`; the menu sends `/subshells/<id>`.

Two things the person will notice, and neither is something this feature
tries to fix:

- **They sign in again over there.** Cookies do not cross from the webview to
  the browser (different cookie jars, same origin or not), so the browser
  arrives signed out.
- **Subshell Server opens its LOOPBACK origin**, because that is the only
  origin its window is ever pointed at. Passkeys are bound to the configured
  `APP_BASE_URL` host (better-auth derives the rpID from the static baseURL,
  not the request host), so a passkey works on that address only if
  `APP_BASE_URL` is the loopback one.

## Networking: one card that is a state machine (spec 2026-09-15)

`/settings/networking` and the first-run step render ONE component,
`components/networking/network-plugin-card.tsx`; the wizard's `compact` prop
changes the FRAME and never the acts. The plugin owns its copy: hints, labels
and step text render verbatim; the page owns the shape and the consequences
that are the SERVER's. Publishing moves no boot-time identity and writes no
config: the Addresses card is the page's one config.env writer, and what is
trusted is a LIVE registry: its own local origins ∪ the operator's
`TRUSTED_ORIGINS` extras ∪ every ENABLED network plugin's addresses (a
`private` network from `joined` up; a `public-with-gate` one only while
published). Nothing privileged is ever a button: this server has no terminal
to answer a password prompt. A refusal is an ANSWER, rendered inline. And
**a network plugin must never be launchable**: every picker filters
`type === "agent-harness"` positively, and reverting either filter fails a
test.
**Working on the networking card, its hooks, or the wizard's network/tmux
steps: read apps/server/web/docs/networking-card.md first.**

## Talking to the backend

All backend traffic goes through shared helpers; the only raw `fetch` calls in
components are the better-auth sign-in/sign-out posts:

- JSON endpoints: `apiFetch<T>` / `apiPost<T>` from `src/lib/api.ts` (cookie
  credentials included; failures throw `ApiError` with a numeric `status`).
- Current user: `getSessionUser` / `useCurrentUser` in `src/lib/auth.ts` hit the
  better-auth `get-session` endpoint through `apiFetch`. Sign-in (`routes/login.tsx`)
  and sign-out (`components/app-sidebar.tsx`) POST straight to better-auth's
  `/api/auth/*` endpoints.
- Terminal attach: `src/lib/use-subshell-ws.ts`: a short-lived (30 s) single-use
  WS token minted over REST, then the `/ws` connection. Never put the subshell
  bearer token in a URL.
- Uploads/streaming: the fetch paths in `src/lib/subshell-uploads.ts` (driven by
  `src/hooks/use-terminal-uploads.ts`).

**A 200 from better-auth is not a stored session, so sign-in verifies before it
redirects** (2026-09-18). better-auth derives cookie security from
`APP_BASE_URL` rather than from the request, so an instance whose base URL is
an https address marks its session cookie `Secure` and prefixes it
`__Secure-`, which a browser on an http page discards on receipt. The POST
succeeds, the redirect to `/` finds no session and bounces straight back, and
the form reads as having rejected a correct password. So `routes/login.tsx`
pays one extra `getSessionUser()` round trip on the one press where being wrong
costs a person their way in; **do not remove it as redundant with
`useCurrentUser`**, which is the read that already ran and found nothing.

There are THREE outcomes, not two, and `lib/sign-in-diagnosis.ts` owns the
words for the ones that are not a redirect. A session that exists redirects; a
session that does not gets the diagnosis (which never blames the credentials,
and whose remedy inside Subshell Server names the assistant's Server Addresses
screen; the dashboard cannot be reached without the session just lost). A
check that could not RUN is its own answer: `getSessionUser` throws on anything
that is not a 401/403 precisely so a failed read is never read as signed-out,
and folding it into the second case would tell someone to change an address
that works.

**Hand-written type mirrors must be checked against the server's schemas.**
`src/types/` holds hand-written mirrors of API response shapes, and Elysia
strips fields a schema does not declare, so a client/server mismatch is
SILENT: `types/network.ts` ↔ `apps/server/api/src/api/network/schemas.ts` and
`lib/split-workspace-refusal.ts` each record an instance of exactly that.
Check both when you touch either.

## Testing

`bun test` with `src/test-setup.ts` preloaded (via `bunfig.toml`; it registers
happy-dom globals for component tests). Component and
lib tests live in `__tests__/` next to the code (`components/__tests__/`,
`lib/__tests__/`). Tests are pure-function and component-level; browser-level
end-to-end coverage lives in the repo-root `e2e/` workspace (Playwright):
`bun run test:e2e` from the repo root boots its own backend and needs a real
tmux + a one-time `bunx playwright install chromium`.

When polling for a Happy DOM element to disappear, assert a boolean such as
`expect(screen.queryByText(text) === null).toBe(true)`. A failing
`expect(element).toBeNull()` makes Bun serialize the full DOM graph, which can
block the state update the test is waiting for and exhaust CI timeouts.

## Workspaces and the split flow (spec 2026-10-17)

**Add a subshell to a workspace** opens the ordinary add-subshell dialog, creates a real, NAMED
workspace around the current subshell, and navigates to
`/workspaces/$id?add=…&dir=…`; the dock and the tab strip consume that intent
once dockview is ready, through their ordinary `handleAdd`, so the first split
and every later add run ONE code path. Nothing is "unsaved": the workspace is
in `GET /api/workspaces` from the moment the POST answers, and that LIST
carries each workspace's PANES, which is what the rail's tree renders from one
query. The tree shows ONLY workspaces: an unfiled pane lives in the subshells
list's machine groups, never in an "Ungrouped" branch (operator ruling
2026-10-17, which deleted that section). Adding a pane is IDEMPOTENT (UNIQUE `(workspace_id, subshell_id)`; the
second add returns the same row with `alreadyPresent`). Removing the LAST
tab retires the workspace (operator ruling 2026-10-20): the subshell keeps
running unfiled, and the surface that removed it navigates to a sane landing
(`/` resumes the next workspace; a rail drag-out lands on `/subshells`).
Closing a subshell itself remains a separate action. The user is ALWAYS in a workspace: a launch raised
with none on screen JOINS an existing one (the remembered-then-recency
workspace, via the idempotent pane-add; only an instance with none opens
one around the pane - `autoFile` in
`hooks/use-create-subshell.ts`; the add-pane and new-workspace dialogs pass
false and file it themselves), and a plain click on a rail row or cell
means the tab (`hooks/use-open-pane-as-tab.ts`: focus it on
screen, else its holder via `armPaneFocusOnArrive`, else create one). The
landing `/` is a direction, not a page: last visited workspace, else most
recently touched, else the one-button empty state. The create response is
still CHECKED, not trusted (`lib/split-workspace-refusal.ts`), now only for a
server old enough to drop `subshellId`.
**Working on splits or workspace membership: read apps/server/web/docs/workspace-first.md first.**

## Terminal gotchas

**Pane bytes are untrusted input: a terminal renders them in xterm, never as
injected HTML.** A PTY stream can carry anything a program printed, and the
SPA must not route it through anything that parses markup.

Workspace panes hold live xterm.js terminals inside dockview panels. A dockview
panel remount disposes its terminal, closes the WS, and forces a history
replay; every panel must keep `renderer: "always"`, which is what keeps the
DOM alive when a panel is hidden. **Which presentation mounts is decided by
`useIsPhoneLayout` (touch-primary AND below the tiling width), not by width
alone**: the dock is mounted for narrow desktop windows too, so the phone's
tap-only strip never takes draggable tabs off a window holding a mouse.

**Working on the terminal, dockview, touch/swipe handling, or shared-grid
sizing, and before ANY `dockview-react` upgrade (which a standing hand-run
probe gates): read apps/server/web/docs/terminal-gotchas.md first.**

## SSH relay launch and setup

The SSH terminal choice in New subshell can use loaded SSH-agent keys from
another machine the user can launch on. Both the connecting machine and key
source follow existing machine launch access; configuration stays owner/admin.
There are no separate SSH grants or approvals. The default omits `keyHome`
and uses the connecting machine's own keys. A relay launch carries explicit
fingerprints, retained for “Set up Subshell here”; never silently substitute or
widen the selection when keys disappear or a machine goes offline.

The SSH tab opens directly on its connection form and preserves launch choices
and workspace/split context. Selecting another node's keys reveals its picker
and key roster inline. Start SSH subshell enables outgoing SSH on the connecting
node only when the viewer can configure it and the disabled flag is its sole
blocker, with a gold notice before submission. Recheck readiness before enabling
and before launching. Node pages manage SSH through their settings card.
When a relay connection has no trusted destination identity, its launch refusal
opens a one-time confirmation in the connection flow. Cancellation saves nothing;
acceptance submits the server-issued token and retries the captured launch once.
Changed identities never use that prompt. Settings → Presets has Agent and SSH
tabs; the SSH tab manages saved connection choices, not host keys. Applying a
preset clears any local key selection. Saving a local-key preset retains only
the authentication choice, never credentials or approval. Recent destinations
stay in the launch suggestions; `/settings/ssh` redirects to `/presets?type=ssh`. The confirmation shows the destination's public fingerprint outright
(copyable), with no key material for the user to paste or manage.
Old `/connect` links open the same
subshell dialog through `/new?kind=ssh`. Failed reads must stay distinct from
empty lists, with retry actions. Read `docs/launch-form-picker.md` for the
shared draft, readiness, and launch-callback contracts.

“Set up Subshell here” can be dismissed while running. Its owner-scoped status
read observes stages selected by the server, never installer output. Reopening
or refreshing joins the same running operation; a duplicate POST also joins it.
Completed results remain for one hour in the running server process. This is
not a durable job across server restarts: after a restart, check Nodes and the
destination before retrying an interrupted install. Keep that limitation honest
in any future recovery UI.

Enrollment without a confirmed connection is terminal status `enrolled`, with
the node id retained. Link to that node and its service recovery; do not offer
another install or describe it as connected.

## Preset sharing

Agent and SSH presets use the same owner-controlled View/Edit grants as
subshells. The API returns viewer-relative access and owner names; library
actions, read-only details, and launch pickers consume that metadata. Share
and Delete stay owner-only. The shared sharing dialog stages grants until
Save and must not treat a failed grant read as an empty list. See
[the user guide](../../docs/content/docs/presets/use.mdx#share-a-preset) and
[the security model](../../../docs/security.md) for disclosure and launch
boundaries.


Preset file version 1 is validated by `src/lib/preset-file.ts`. Export projects
settings explicitly, excluding ownership and grants. Import parses before any
write, then calls the ordinary create API, so plugin, node, and SSH checks
remain authoritative. SSH imports carry the exported destination as the
expected destination while resolving their saved alias; never silently follow
an alias to another host. The file limit is 1 MiB. Keep validation, exports,
and the public guide aligned when adding a field or version.

## Preview in subshells

Workspace panes offer Preview as a separate workspace tab. Desktop previews use the same dockview layout as terminals, so tabs can be moved and split without rebuilding the terminal. Each preview has one parent pane and appears as a child entry under its subshell in the sidebar. Closing the preview leaves that pane and subshell running. Stored preview panels use `preview:<paneId>`; the server keeps them only while the parent pane is visible to the workspace owner. Hidden preview tabs release viewer subscriptions and reopen their selected view when shown again. Phone previews use their own entries in the flat tab strip and never overwrite the desktop layout.

The standalone subshell route still uses PreviewSection. In a workspace tab the section fills the panel and selects one app, browser watch, or screen at a time. App and screen viewers fill their preview area and support full screen. Phone app previews prepare a real new-tab link after the request, avoiding popup blocking. The launch form checks the selected machine’s Linux support, Preview setting, and live Xvfb/x11vnc/xauth prerequisites before enabling Virtual display. Missing programs and failed checks show visible guidance and a Recheck action. A successful check hides Recheck.

Subshell list views carry `virtualDisplay` metadata for the sidebar and headers. The monitor indicator uses that shared row rather than starting per-row preview scans. Remote display updates ride the existing batched liveness probe.
