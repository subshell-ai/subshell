# Server web AGENTS.md

Documentation for the React SPA the control plane serves (`apps/server/web`,
`@internal/server-web`). It is the SERVER's web UI and nothing else's, which
is what its place in the tree says: it sits beside `apps/server/api`, which
builds it into its binary and serves it. The two desktop apps carry their own
small bundled pages under `<app>/ui/` and share nothing with this one.

**Styling follows `docs/design-system.md`** (six type roles, two weights,
shadcn colour names), and `bun run lint:design` fails on a literal size,
weight or colour outside the token file. Pick a role, never a number.

**Topic deep dives live in `apps/server/web/docs/`, one file per area.** This
file keeps what constrains an edit anywhere in the app; each moved section
leaves a routing line naming the file to read first. The moved text is
verbatim: nothing was dropped or reworded in transit.

## URLs

- Dev server: http://localhost:5174 (Vite), which proxies `/api` and `/ws` to the
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
**Working on the rail (grouping, collapse prefs, row tooltips, the Needs
Attention spotlight): read apps/server/web/docs/sidebar.md first.**

**The live feed has no cadence, and that is load-bearing for every reader.**
One snapshot at connect, then a frame only when something changed: a snapshot
must not clobber a newer event; a broadcast carries no per-viewer `access`
stamp (the client keeps the access it holds); pane previews are PULLED by the
surfaces that draw them. The feed writes exactly `SUBSHELLS_QUERY_KEY`, plus
the per-id `["subshell", id]` entry only when it already exists; removals and
access changes INVALIDATE it instead. Pages must follow the CACHE, not the
feed's own copy; activity derives from `lastOutputAt` against a clock
(`hooks/use-clock-tick.ts`), and any NEW surface rendering `subshellIndicator`
needs its own tick.
**Working on anything that reads or writes subshell state: read apps/server/web/docs/live-feed.md first.**

**The home page reads its state as a dot and segments by machine** (tiles and
the list share ONE `SubshellSection` model; the machine combobox is ALWAYS
drawn), and two instance-wide gates decide what may launch anywhere:
`allow_server_subshells` refuses every new launch and restart on the host
non-destructively (running panes finish; the `local` row stays visible), and
`lockdown` stops every running subshell everywhere and 403s every create and
restart before any machine is chosen: turning it ON is typed-confirmed, a
re-submitted ON is INERT, and `components/lockdown-banner.tsx` tells everyone
signed-in, mounted in `__root`.
**Working on the home page, the launch pickers, or these gates: read apps/server/web/docs/home-launch-guidance.md first.**

**The admin surface is TEN pages behind one collapsible group** (General,
Users, Auth, API keys, Plugins, Service, Networking, Updates, Status, Logs),
gated as a WHOLE: a member's rail lists none of them, and none of them
renders for a member who types the URL. The gate the others copy is
`routes/settings_.status.tsx`'s: server-derived `viewerIsAdmin`, with
`undefined` counting as NOT admin.
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

**The launch form asks Agent → Preset → Node → Working directory and asks
nothing it cannot answer.** A directory is a claim about ONE machine:
changing Machine clears `workingDir` and re-arms the per-machine seed, and the
folder picker is machine-scoped end to end. Node options filter on the
server's own `canLaunch` (never a re-derived rule). Two kinds of unlaunchable
are shown differently on purpose: a host narrowed by its shares VANISHES; a
node in maintenance is KEPT and greyed with the reason. A presetless launch
omits `presetId`: absence, never null.
**Working on the launch form, presets, the folder picker, or no-launch states:
read apps/server/web/docs/launch-form-picker.md first.**

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
is gone: the allowlist and Server-URL cards render on the Overview. The
harness card's Re-check gate is a DIFFERENT rule; do not collapse them.
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

`components/mobile-install-dialog.tsx` is UNGATED, desktop shells included:
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
  and both work in both apps: the rail's **Open in browser** row
  (`components/app-sidebar.tsx`, last in the `<nav>`) and the same item in
  `components/subshell-actions-menu.tsx` (`sidebar: true`, so the rail's
  right-click menu carries it too).

**The footer's app-update row is a server-desktop surface, and it is mounted
where that is structural** (spec 2026-09-17 §5.3):
`components/desktop/desktop-app-update-row.tsx`, read via
`hooks/use-desktop-app-update.ts`, rides `desktop-sidebar.tsx`'s `footerEnd`
above `UserMenu`: the rail `__root.tsx` only renders on `isServerDesktop()`, so
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
pinned plane), and refuses anything that could name a host. The rail sends
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

## Drafts and the split flow (spec 2026-09-14)

**Split** opens the ordinary add-subshell dialog, creates a DRAFT workspace
around the current subshell, and navigates to `/workspaces/$id?add=…&dir=…`;
the dock and the tab strip consume that intent once dockview is ready, through
their ordinary `handleAdd`, so the first split and every later add run ONE
code path. Drafts are ABSENT from `GET /api/workspaces`. A draft below two
panes is DISCARDED: server-side when a pane is removed, and client-side by
`hooks/use-discard-thin-draft.ts`, which is GUARDED by the `?add=` intent:
break that ordering and every split discards itself. And the create response
is CHECKED, not trusted (`lib/split-workspace-refusal.ts`).
**Working on drafts, splits, or workspace membership: read apps/server/web/docs/drafts-split.md first.**

## Terminal gotchas

Workspace panes hold live xterm.js terminals inside dockview panels. A dockview
panel remount disposes its terminal, closes the WS, and forces a history
replay; every panel must keep `renderer: "always"`, which is what keeps the
DOM alive when a panel is hidden.

**Working on the terminal, dockview, touch/swipe handling, or shared-grid
sizing, and before ANY `dockview-react` upgrade (which a standing hand-run
probe gates): read apps/server/web/docs/terminal-gotchas.md first.**
