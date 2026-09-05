# Frontend AGENTS.md

Frontend-specific documentation for the React app.

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

`routes/settings_.status.tsx` (`/settings/status`, components in
`components/admin-status/`, data in `hooks/use-admin-status.ts`) is the
read-only half of the admin surface: `/settings` is where an admin CHANGES the
instance, Status is where they see what it currently IS. Its admin gate is the
same server-derived `viewerIsAdmin`, and `undefined` counts as NOT admin — the
query is `enabled`-gated on it so a non-admin mount fires no doomed 403.

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
binaries until `release:client` runs, and the one-liner 404s on every machine
until then. The field being ABSENT (older server behind a cached PWA) stays
silent; the query still loading or errored shows a "could not check" line
instead — no verdict without data. Opening the dialog refetches so a just-
published artifact set is visible at once.

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

## Terminal gotchas

Workspace panes hold live xterm.js terminals inside dockview panels. A dockview
panel remount disposes its terminal, closes the WS, and forces a history
replay — every panel must keep `renderer: "always"`, and every `dockview-react`
upgrade must re-run the manual probe documented in the root `AGENTS.md`.

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
