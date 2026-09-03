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

The Nodes UI (`routes/nodes.tsx`, `routes/nodes_.$id.tsx`, components grouped in
`components/nodes/`, data in `hooks/use-nodes.ts` + `use-node-shares.ts`): the
Add-node dialog renders the install one-liner from `GET /api/settings/public →
appBaseUrl` — NOT `window.location.origin` (fallback only while settings load) —
so the command always names the same SERVER the backend bakes into the served
`/install.sh`; a loopback `appBaseUrl` renders the amber "remote node cannot
dial this machine" hint.

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
