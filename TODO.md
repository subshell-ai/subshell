# Subshell — TODO / Resume Notes

> Status as of 2026-08-23 (evening session). Remote-operations round fully complete — see "Committed (remote-operations round)" and "Verified" below. Operator-UX round complete before it (see "Committed (operator-UX round)").

## Committed (remote-operations round, on `feat/remote-operations` → main)

- `1deabd3` feat(db): liveness + auto-restart columns (migration 0003)
- `a318bb0` feat: persisted liveness — crash detection in reconcile (alive/exitCode)
- `6c8f838` feat: exponential-backoff auto-restart on unexpected exit
- `e170f64` feat: session manager page + alive-aware home (paused/exited chips)
- `41db28b` feat: terminal page exited state + restart/delete + backoff status + reconnect pill
- `0814269` feat: WS auto-reconnect with full replay dedupe (offline pill is now real)
- `9310f28` feat: / command palette (copy, clear, find, exit, help)
- `2f11299` feat: rate-limited auth (backoff delay) + logout
- `1301dfc` feat: password change, admin user management, audit log endpoint
- `2d03e42` fix: static audit import (no dynamic imports) + test cleanup by id
- `4d533e0` feat: remote operations — boot reconcile + docs + full sweep

### Deferred (remote-operations round)

- **Cost/usage tracking** — still deferred (no per-session token/time accounting yet).
- **Internet-grade hardening** — deferred by design: no TLS enforcement, no 2FA/lockout, no rate limiting beyond login backoff. The service is trusted-network-only; export beyond VPN/Tailscale/SSH requires the `.claude/rules/security-context.md` checklist (auth, CORS validation, rate limiting, HTTPS, input length limits, pagination).
- **Auth sign-in/out audit events** — not recorded yet (auth flow is better-auth passthrough; session lifecycle + user.create are audited). Candidate for a future round.
- **Non-admin UI gating** is client-side only (route renders "Admin-only" on 403); API is the enforcement point.

## Committed (operator-UX round, all on `main`)

- `1b660ab` feat(db): add `last_output_at` + `notes` to sessions (migration 0002)
- `6609dff` feat: session activity heuristic + preview helpers (`computeActivity`/`stripAnsi`/`tailLogLines`)
- `98da158` feat: live home page — activity + preview + search + notes (SSE cards, `SessionCard`, `SessionSearch`, `NotesDialog`, `useLiveSessions` hook)
- `37db270` feat: live session SSE (`GET /api/events` via ws-token) + notes PATCH + restart endpoint
- `cf5e435` feat: session switcher + restart + transcript search on terminal page (`SessionSwitcher`, `TranscriptSearch`, `onFrame` in use-session-ws)
- `8960bd0` feat: session preview field (tail of running session log) + `docs/superpowers/plans/2026-08-23-operator-ux.md` (plan of record)

## Verified (done — full sweep 2026-08-23 morning)

- Backend E2E: SSE stream emits session list with `activity`/`lastOutputAt`/`notes`; `PATCH notes` round-trips; `POST restart` spawns "name (2)"; WS attach with replay + output.
- Browser smoke (terminal page, via chrome-devtools MCP):
  - Running session: xterm renders (canvas painted), **SessionSwitcher** pill for other session, **Find** finds text (1/1 match counter + prev/next enabled), **Terminate** works (confirm dialog → `status: terminated`, `preview: []`).
  - Terminated session: **Restart** button + "Session is not running." message → accept → new session "SSE Test (2) (2)" created (backend log confirms), page navigates to new session, status running + Terminate.
  - Caveat: xterm text-canvas `getImageData` is CORS-tainted for pixel-level text proof on the post-restart page; rendering confirmed via element presence + caret/cursor pixels + working WS pipeline. Screenshots couldn't be viewed (vision model unavailable) and were not kept.
- Sessions list still holds test sessions: "SSE Test" (running), "SSE Test (2)" (terminated), "SSE Test (2) (2)" (running) — created by this smoke round under profile `admin@subshell.local` (password reset to `admin123`).
- Full verification sweep: `bun install` clean; `verify-types` (6 pkgs) clean; lint clean for backend/frontend/harnesses (sqlite-dialect has 1 pre-existing `noExplicitAny` warning — non-blocking); tests: backend 64 pass, sqlite-dialect 5, harnesses 7, frontend + backend-client pass-with-no-tests.
- Frontend prod build: `bun run --cwd apps/frontend build` rebuilt (dist has operator-UX SPA).
- Dev servers running: backend `bun run ./src/index.ts` on :3080 (restarted fresh — `preview` live), frontend Vite on :5174 (HMR). Chrome MCP restarted (stale chrome on the MCP profile was holding the singleton lock; killed + removed stale `Singleton*` files).

## REMAINING WORK (next session)

Nothing blocking. Optional backlog:

- `git push` origin/main (26 commits ahead locally).
- Operator-UX plan file lists further feature candidates (see `docs/superpowers/plans/2026-08-23-operator-ux.md`).

### Session delete (done)

- `DELETE /api/sessions/:id` — terminates first if running, removes the DB row + `data/sessions/<id>.log`. Trash button on every home-page card (confirm dialog; SSE refresh). Verified live (terminated + running + 404) and in the browser; the dev test sessions ("SSE Test…") were cleaned up with it.

### Deferred code-review items (design-level, documented in code)

- **SSE token design** (`apps/server/src/api/live.route.ts` + `useLiveSessions.ts`): ws-token TTL (30s) forces a reconnect ~every 30s; the `connected` badge may briefly flap offline. Self-healing (failed/cancelled token → next connect 401 → retry with fresh token); move to real auth (cookie via `withCredentials`) if ever exposed beyond localhost.
- **60s idle heuristic** (`computeActivity`, session-manager.service.ts): a working-but-quiet agent (>60s silent) shows as idle (warning chip). Consider a progress-aware signal (harness heartbeat / adaptive window) in a future round.
- **Notes API**: maxLength 2000 + server-side trim/normalize now in place; empty/whitespace notes normalized to null.
- **Restart-mid-render edge**: refreshing the terminal page during a restart leaves old scrollback until reconnect; the "Session is not running." fallback covers the common case. Not worth fixing. (#8)

## Commands / shortcuts

- Backend dev: `cd apps/server && bun run dev` (port 3080). Runs from apps/server dir only.
- Frontend dev: `cd apps/frontend && bun run dev` (port 5174; proxies /api + /ws → 3080). Port 5173 is taken by the user's docker container.
- Prod serve: `bun run --cwd apps/frontend build` + `bun run --cwd apps/server build` then `cd apps/server && NODE_ENV=production BETTER_AUTH_SECRET=… DATABASE_PATH=./data/subshell.db APP_BASE_URL=http://localhost:3080 bun run ./dist/index.js`
- DB reset (dev): `rm -f apps/server/data/subshell.db* && rm -rf apps/server/data/sessions`
- Dev password reset: `cd apps/server && bun run scripts/set-admin-password.ts admin@subshell.local admin123`
- **Persistence gotcha**: background servers die between tool calls — use `nohup … > /tmp/subshell-*.log 2>&1 &` and check with `lsof -i :3080`. Always kill by PID.
- The dev backend does NOT hot-reload unless started with `--watch` (`bun run dev`); plain `bun run ./src/index.ts` serves stale code after edits — restart after backend changes.

## Gotchas learned (avoid re-debugging)

- **Kysely migrator + bun:sqlite**: `supportsCreateIfNotExists` was missing → second boot crashed ("table kysely_migration already exists"). Now in `packages/sqlite-dialect/src/adapter.ts`.
- better-auth under Bun: `.all("/api/auth/*", ({request}) => auth.handler(request))` — `.mount()` strips prefix and breaks auth.
- Roles NOT on the auth user table (no `role` column); they live in app `user_meta` via `databaseHooks.user.create.after`.
- Passwords are scrypt `salt:hash` via `@noble/hashes` — use `import { hashPassword } from "better-auth/crypto"` (NOT node:scrypt) to reset.
- WS auth: HttpOnly cookie can't be read by JS + Vite WS proxy drops Cookie headers → ws-token endpoint (single-use, 30s TTL). Same pattern used by the SSE feed.
- `bun run ./src/index.ts` from repo root fails (workspace resolution) — always `cd apps/server` first.
- ANSI-stripping regexes: biome flags raw control chars — use named consts with `// biome-ignore lint/suspicious/noControlCharactersInRegex`.
- **Browser automation (chrome-devtools MCP)**: stale chrome holding `~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock` blocks the MCP ("browser already running"). Fix: kill all chrome processes using that profile + `rm -f SingletonLock SingletonSocket SingletonCookie`. Screenshot capture works but in-headless vision (image description) may be unavailable — prefer DOM/eval checks over screenshot-review.
- **Session search "Find"**: match counter is the authoritative check ("1/1"); xterm text rows aren't exposed in the a11y tree/canvas (canvas renderer) so don't look for text nodes.
