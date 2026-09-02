# Mote — Project Overview

**Mote** is a web application for creating, viewing, and managing interactive **agent harness
sessions** — real CLI coding agents (Claude Code today; hermes, pi, opencode later) that you
launch from the browser, attach/detach via a terminal UI, and terminate. It's **local-first**:
sessions spawn as tmux-backed PTYs on the machine running the app; Docker is secondary.

> This page is the quick orientation. The full system design — credential model,
> encrypted-channel protocol, the `mote mcp` contract, session/token choreography and the
> invariants that bind them — lives in the **[architecture reference](architecture.md)**,
> which is authoritative when anything here disagrees with it.

## Architecture

```
browser ──•── /                   Elysia serves built frontend (SPA)
          │                       + API + WS + auth on ONE port (default 127.0.0.1:3080)
          ├─ /api/...             REST/JSON (better-auth at /api/auth/*)
          ├─ /ws                  session attach WebSocket (?session=&token=)
          └─ /docs                OpenAPI (Scalar UI)
               │
               └─ spawns ──► tmux server (per-session socket: mote-<sha1[:12]>)
                              └──► claude / harness (in PTY, env -i curated env)
                                    └──► `mote mcp` (stdio MCP server, registered in
                                         the harness's own dialect — see arch §4)
                                         └── talks back over /api as the session's
                                             bearer token (channels + session CRUD)
```

### Key decisions

| Area | Choice |
|---|---|
| Runtime | **Bun** exclusively (monorepo via turbo workspaces) |
| Database | **SQLite via `bun:sqlite`** — no native-module deps; Kysely `Dialect` from `kysely-bun-sqlite-dialect`. Every handle opens through `apps/backend/src/db/open-database.ts`, which applies `PRAGMA foreign_keys = ON` — the `workspace_panes` cascades depend on it |
| Sessions | **tmux 3.6+ backed, detachable** (survive browser close); pipe-pane → per-session log file |
| Auth | **better-auth** (email/password); HttpOnly cookie; first user becomes admin; registration gate. Signed-out visitors are guarded to a chrome-free `/login` (first run goes to `/setup` instead). The user roster is instance-wide **read-only**; management (create, audit) is cookie-admin-only. Machine paths: bearer API keys via `@better-auth/api-key` — per-session tokens (revoked on death) + admin-managed system keys; admin surfaces are cookie-only |
| Cross-session comms | **E2EE channels + `mote mcp`**: durable append-only log (no queue), per-recipient sealed envelopes (jose, ECDH-ES+A256GCM) the server cannot read; cursor reads with long-poll; agents manage sessions/channels through 14 `mote_*` MCP tools |
| Terminal | **xterm 6** (fit/webgl/serialize/search addons); dark-only shadcn/ui (Base UI) theme — the old Radix tree was migrated 2026-08-30 (`apps/frontend/.migration/`) |
| Harnesses | Code-time **plugin interface** (`packages/harnesses`); four plugins ship: claude-code & opencode (MCP auto-registered per session), hermes & pi (one-time manual registration, steps shown in the profile editor) |
| Frontend | React 19 + TanStack Router/Query + Tailwind; Vite dev server (port 5174) proxies `/api` + `/ws` to backend |
| WS protocol | **All client frames JSON** (`{type:"input"\|"resize"}`) — see `packages/session-protocol` |
| Uploads | Dropped/pasted files → `<workingDir>/.mote/uploads/`, working-directory-scoped, git-excluded, paths injected via bracketed paste |
| Workspaces | Per-user tiling layout of session panes via `dockview-react`; `layout_json` holds the split tree. Below 1024px it renders as tabs and never writes the layout, so a phone visit cannot flatten a desktop arrangement |
| Mobile | <1024px = drawer shell + tab workspaces (`useIsWide`, `WORKSPACE_TILING_MIN_WIDTH`); ≥1024px = today's desktop shell; accessory terminal key bar sends raw WS `input` frames (same path as desktop keystrokes); PWA manifest, no service worker — spec [`superpowers/specs/2026-08-30-mobile-support-design.md`](superpowers/specs/2026-08-30-mobile-support-design.md) |

## Workspace layout

```
apps/backend      Elysia app: api routes, ws, auth, session manager, tmux runner,
                  static serving (built SPA), migrations; src/mcp/main.ts is the
                  stdio `mote mcp` entry (own compile target, never opens the app DB)
apps/frontend     React SPA: TanStack Router/Query, xterm, shadcn/ui, dark theme
packages/harnesses         HarnessPlugin interface + four built-in harness plugins
packages/backend-errors    shared error handler (scaffold)
packages/backend-client    Eden Treaty client (scaffold; types inferred from backend's `App` type)
packages/session-protocol  WS frame contract shared by backend + frontend
packages/mcp-core          stdio `mote mcp` server, shared by backend's mote-mcp binary and the agent
packages/tsconfig          shared TS config (scaffold)
```

## Key flows

1. **Setup wizard** (first visit): register admin → manage harnesses → done. No
   profile step — every enabled harness already carries a blank auto-seeded
   **Default** profile (created at registration / admin user-creation / harness
   enable / boot backfill; self-healing: re-seeded only when a user has zero
   profiles for an enabled harness, never on a list read, never overwriting).
   A Default is unremovable (`is_default` flag; DELETE refuses it) but fully
   editable — to get rid of one, disable its harness: that hides every profile
   it owns and blocks new sessions, and re-enabling brings them all back.
2. **Create session**: choose host folder (in-app browser), profile, optional name
   (defaults to date/time) → backend validates, spawns tmux + harness with `env -i` curated env
3. **Terminal page** (`/sessions/:id`): fetches a single-use WS token via an authenticated
   REST call (HttpOnly cookie works for HTTP), connects `/ws?session=&token=`, streams
   `replay` + `output` frames into xterm, forwards keystrokes; `capture-pane` replay on attach
4. **Terminate**: kills the tmux session tree; DB row status → `terminated`
5. **Reconcile loop** (60s interval): marks rows `terminated` when tmux session is gone;
   also sweeps expired WS tokens
6. **Workspace** (`/workspaces/:id`): sessions tile via `dockview-react` above 1024px, tabs
   below it; every panel renders with `renderer: "always"` so moving, splitting or hiding
   a pane relocates its terminal in place rather than unmounting and remounting it
7. **Cross-session comms**: session start mints a bearer token + MCP config → the harness
   spawns `mote mcp` (stdio) with that token in its inherited env → agents create/join
   **channels**, post E2EE messages (sealed to every member's keypair), long-poll reads
   with a per-session cursor, and can spawn/manage other sessions. On terminate/delete the
   token is revoked; auto-restart rotates it. See
   [`superpowers/specs/2026-08-28-cross-session-comms-design.md`](superpowers/specs/2026-08-28-cross-session-comms-design.md)
   and the plan in `superpowers/plans/`.

## Security posture (explicit design)

- Binds loopback by default; Docker compose binds `127.0.0.1`
- All `/api/*` except auth + setup-status requires a session (401 JSON otherwise)
- WS attach requires a **short-lived (30s) single-use token** issued by the authenticated
  REST endpoint — replay-resistant (verified: second use gets `4001 unauthorized`)
- Harness processes run under `env -i` with a **curated env** — app secrets (DB path, auth
  secret) never reach the agent; profile env vars merge on top
- Harness argv built from parts (`buildCommand`), never a shell string
- PTY output treated as untrusted — rendered only by xterm, never as HTML
- Path traversal guard on `/api/files/explore`
- `SameSite=Lax` + `httpOnly` cookies; `secure` in prod
- Single-user-now architected for multi-user: `user_id` on all tables, admin flag via `user_meta`
- **Channel E2EE**: message bodies sealed per-recipient (server stores ciphertext only).
  The boundary protects the server/remote peer from message *content* — **not** metadata
  (channel names, membership, timing, sizes, principals stay plaintext) and **not** a local
  OS user, who can read a session's keypair off the same disk. Session bearer tokens are
  scoped and revoked on death; system keys are long-lived full-access bearer credentials
  held by admins.

## Testing

- Backend uses **`bun test`** (vitest was removed — its node worker cannot
  import `bun:sqlite`)
- Run: `bun run test` (root, all packages) / `cd apps/backend && bun test`
- Type check: `bun run verify-types` (root) / `cd apps/backend && bunx tsc --noEmit` (from the
  package dir, not repo root)
- Lint: biome — `bun run lint` fixes (`--write --unsafe`), `bun run lint:check` verifies read-only
- Hooks: lefthook runs `lint:staged` on **pre-commit** and `verify-types` + `lint:check` +
  `test` on **pre-push**; the root `prepare` script installs them on `bun install`

## Status (2026-08-30)

Backend fully functional; frontend pages and the WS terminal attach work E2E; single-port
prod serving (built SPA + API + WS + docs on one port) works. **Cross-session comms** —
E2EE channels and the `mote mcp` server (channels + full session CRUD) — shipped: verified
by a two-process end-to-end test (real backend + two `mote mcp` children; ciphertext-only
storage asserted at the byte level) and a live-browser pass over the admin key lifecycle.
**Mobile support** shipped alongside it, proven by the Playwright suite grown to 22 green
tests (plus one intentional device-project skip) across three projects — desktop plus two
device projects (iPhone 15 Pro incl. landscape, iPad Pro 11 landscape); key-bar bytes are
verified to land in a real tmux pane. **Auth experience**: chrome-free sign-in with a
signed-out guard and return path, and an instance-wide read-only user roster (management
stays cookie-admin-only), pinned by `e2e/tests/10-auth-experience.spec.ts`.
