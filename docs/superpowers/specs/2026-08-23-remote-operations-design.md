# Remote Operations — Design Spec (2026-08-23)

**Deployment model:** VPN/SSH tunnel (trusted network, **no internet exposure**). The box binds `0.0.0.0` behind WireGuard/Tailscale/SSH port-forward; users reach Mote from their laptop. Security hardening is *trusted-network depth* (rate-limited auth, logout, password change, user management, audit) — deliberately **not** internet-grade (no lockout/2FA/TLS enforcement; those are a future round if the deployment model changes).

**Goal:** make Mote dependable + pleasant when the operator is *not on the box* — sessions that survive the backend and worker processes, a terminal that survives flaky tunnels, and the admin basics to run it for a small team.

**Out of scope (deferred):** cost/usage tracking, multi-user *roles* beyond admin/operator basics, 2FA/account-lockout, TLS enforcement, mobile layout polish.

---

## Core architectural decision: persisted liveness

Today a session's `status` is only reconciled against tmux by a 60s sweep, so crashes sit undetected for up to a minute, and a real pane can outlive a stale `running` row (a backend restart would "lose" it). This round moves the authority from a transient tmux query to a **persisted DB flag**:

- Migration 0003 adds to `sessions`:
  - `alive INTEGER NOT NULL DEFAULT 1` (1 = pane process alive; 0 = dead/paused)
  - `exit_code INTEGER NULL` (harness exit status when it died)
  - `started_at TEXT NULL` (last process start; drives uptime)
  - `backoff_count INTEGER NOT NULL DEFAULT 0` (consecutive auto-restarts, exponential)
  - `next_restart_at TEXT NULL` (when a backoff-delayed auto-restart is due)
  - `restart_on_exit INTEGER NOT NULL DEFAULT 0` (opt-in auto-restart per session)
- Migration 0003 also adds `restart_on_exit INTEGER NOT NULL DEFAULT 0` to `profiles` (the per-profile default).
- `status` remains `running | terminated` (operator lifecycle); `alive` tracks actual process state. The frontend combines them: `alive=0, status=running` → "paused/exited" card.

**Impact:**
- Liveness survives backend restarts (boot → immediate reconcileAll re-stamps `alive`).
- The terminal page can distinguish *dead* ("Session exited (code N)") from *terminated*, and the reconcile sweep gets a single source of truth.
- **Auto-restart keeps the same session row** — other screens (SessionSwitcher, history) stay coherent; the existing `Restart` button still creates a *new* row.

---

## Cluster 1 — Self-healing sessions

### 1a. Migration 0003 (`apps/backend/src/db/migrations/0003-remote-ops.ts`)
Columns above; `down()` drops them. Wired into `apps/backend/src/db/migrate.ts` provider map; `sessions.db-types.ts` updated (`alive`, `exitCode`, `startedAt`, `backoffCount`, `restartOnExit`). Migration test like 0002.

### 1b. Crash detection in the reconcile sweep (`SessionManagerService.reconcileRows`)
- If tmux session exists → `alive=1` (fold in the earlier mtime-stamping of `lastOutputAt`).
- If tmux session gone + `alive=1` → `markCrashed`:
  - Read exit code: `tmux capture-pane` returns nothing on a dead pane; use `display-message -p "#{pane_dead}"` and `#{exit_status}` (tmux 3.6 has `exit-status` per pane). Fall back to `null` when unavailable.
  - Set `alive=0`, `exitCode`, keep `status='running'` (it's a *crash*, not a terminate).
  - Try `TmuxRunner`'s socket-file cleanup (`sessionLogPath`-family).
  - If pane dead but *session still exists* → open a debug shell (`send-keys` `bash`) so the operator can inspect; mark `paused`.
- Backend boot: after `startServer`, run an immediate `reconcileAll()` (not just the first 60s tick).

### 1c. Plugin-aware exit status (`packages/harnesses/src/claude-code.ts`)
`ClaudeCodePlugin` gains an `exitStatus(code): string` mapping (documented CLI exit codes, e.g. 10 = loop-complete, 1 = error) so the UI can show "exit: closed-loop complete" instead of a bare number. Other harnesses default to numeric.

### 1d. Auto-restart with exponential backoff
- Profile gains `restart_on_exit` (profiles table migration + `ParseProfile` + edit UI toggle).
- In `reconcileRows`, if `alive=0 && status='running' && restart_on_exit=1`:
  - Delay `30s * 2^backoffCount` (cap 480s, max 6 consecutive).
  - **Backend restart survival:** persist `next_restart_at` on the row so a restart during backoff doesn't fire early; on boot the sweep checks `next_restart_at <= now`.
  - Restart reuses the create path (`spawnHarness`), same row: `alive=1`, `startedAt=now`, `backoffCount++` or reset after a healthy run (define healthy = alive at next sweep).
- New sessions default `restartOnExit` off.

### 1e. Session manager page (`/sessions`, new route `apps/frontend/src/routes/sessions.tsx`)
- Table of **all** sessions: name, status+alive chip ("running / exited(2) / paused / terminated"), workspace, lastOutputAt, uptime, backoff count.
- **Bulk actions** (multi-select + confirm): terminate, restart, delete. Reuses existing endpoints (repeat per id).
- Replaces the current "Completed" card dump on the home page; home page sections: **Running** = `status==='running' && alive` (live cards as today); **Paused / exited** = `status==='running' && !alive` (muted card, "exited (N)" badge, no preview); **Completed** = `status==='terminated'`. The manager page (`/sessions`) is the destination for bulk/history.

### 1f. Terminal page dead-session state
`sessions.$id.tsx`: when `alive=0 && status='running'` → instead of "Session is not running.", show "Session exited (code N)" + Restart / Delete buttons (Restart = new row as today).

---

## Cluster 2 — Remote-resilience polish

### 2a. WS URL base fix (bug)
`apps/frontend/src/lib/use-session-ws.ts` builds `/ws/attach?…` relative — breaks behind a sub-path/proxy. Fix: `new URL("/ws/attach", window.location.origin)`.

### 2b. Reconnect = full replay
Verify the existing path (log tail starts at `lastSize: 0` on attach) and make it explicit:
- On **every** attach/reconnect, the server sends `replay` (capture-pane) then the full tail from byte 0 → client clears its transcript and repaints into the **same** xterm instance (don't dispose on WS close).
- Client dedupes: `replay` resets the transcript copy; `output` frames append. (Frame-number guard if duplicates appear in testing.)

### 2c. Offline/reconnecting indicator
The WS connection state already exists — surface it on the terminal page (small "reconnecting…" pill in the header; green dot = attached).

### 2d. Command bar
`/` opens a small palette in `sessions.$id.tsx`; commands:
- `/help` — list commands
- `/copy` — clipboard-copy the transcript (`navigator.clipboard`)
- `/clear` — `term.clear()`
- `/find <q>` — opens the existing `TranscriptSearch` with the query
- `/exit` — sends Ctrl-D to the pane
Typing `/\` cancels. These run client-side (transcript already exists).

### 2e. xterm lifecycle
Keep xterm mounted + scrollback intact across WS reconnects; only write into it. Fix any duplicate-append on reconnect.

---

## Cluster 3 — Admin + trusted-network hardening

### 3a. Rate-limited auth (`apps/backend/src/auth.ts` + hooks)
- New table `auth_attempts` (`key`=email, `attempt_count`, `last_attempt_at`), migration 0004.
- better-auth `before` hook on `signIn.email`: if attempts exceed threshold (e.g. 5), delay `2^attempts` seconds (cap 30s) before continuing; on success reset; on failure increment. No lockout (deferred).

### 3b. Logout
- better-auth `signOut` route wired (`auth.api.signOut`), and a **Logout** button in the home page header (root layout has no global header — keep it simple: home page header next to "New session").
- On logout, clear query cache + navigate to `/login`.

### 3c. Password change
- Settings page (`apps/frontend/src/routes/settings.tsx`) gains a "Change password" card → better-auth `changePassword` (current + new + confirm); show success/error inline.

### 3d. User management (admin-only)
- API: `GET /api/users` (list), `POST /api/users` (create with email/password/role) — admin-only guard (reuse the existing `role` on user_meta + route-level check like `*ProfileError`).
- Page: `apps/frontend/src/routes/users.tsx` (admin sees it; non-admin 403): table + create form (email/password/role select).
- Data: reuse better-auth admin plugin? Simpler: query the `user`/`user_meta` tables via repositories (no plugin dependency).

### 3e. Audit log
- Table `audit_events` (`id`, `actor_user_id`, `action`, `target_type`, `target_id`, `metadata_json` null, `created_at`) — migration 0004 alongside auth_attempts.
- Record: session `create`/`terminate`/`delete`/`restart`, auth `sign-in`/`sign-out`, user `create`/`role-change`.
- Endpoint: `GET /api/audit?limit=50` (admin only; latest N; no UI page — operator curls it; documented).

### 3f. Docs
README gains a "Remote / trusted-network" section: `HOST=0.0.0.0`, `APP_BASE_URL`, `TRUSTED_ORIGINS`, ufw/VPN guidance, the deferred internet-hardening callout (see `.claude/rules/security-context.md`).

---

## Data-flow / invariants

- Reconcile sweep (60s + boot) is the **only** writer of `alive`/`exitCode`/`backoff` transitions (plus `terminate`/`delete`/`restart` user actions). WS tail only writes `lastOutputAt` (mtime-stamp as today).
- Auto-restart runs inside reconcile — no new timers.
- `alive=0` sessions in the DB are the single source of truth for "what's down" — the manager page and terminal page both read it.
- All admin routes enforce ownership/roles exactly like the existing session/profile routes (owner check → 404; admin check → 403).

## Error handling

- Exit-code read failures → `null` exitCode, log a warning; never fail the sweep.
- tmux dead-socket cleanup best-effort (already-established pattern).
- Auto-restart failures (binary missing etc.) → log + increment backoff; don't crash the sweep.

## Testing

- `bun test` per package: migration 0004 (auth_attempts/audit), session-manager crash-detection + auto-restart backoff (in-memory DB + tmux mocks), auth rate-limit hook, users repository/admin route, audit repository.
- Frontend: `bunx tsc --noEmit` + lint + browser smoke (manager page bulk actions, command bar, logout, users page, reconnecting pill).
- `bun run verify-types` (all packages).

## Files (representative; full lists in the implementation plan)

- Backend: `0003-remote-ops.ts`, `0004-auth-audit.ts`, `sessions.db-types.ts`, `profiles.db-types.ts` (+ `0003` add `restart_on_exit` to profiles), `session-manager.service.ts` (crash/auto-restart/liveness), `tmux-runner.ts` (exit-status helper), `claude-code.ts` (exitStatus), `auth.ts` (rate-limit, signOut), `users.route.ts`, `audit.route.ts`, `sessions.route.ts` (+ `users` guard), `constants.ts` (admin list)
- Frontend: `sessions.tsx` (manager page), `session-card.tsx` (alive chip), `sessions.$id.tsx` (dead state, command bar, reconnect UI), `use-session-ws.ts` (URL base, dedupe), `settings.tsx` (password), `users.tsx`, home header (logout), `lib/commands.ts`
- Docs: README remote section, TODO.md update

## Verification (end-to-end)

1. Migrations up on a dev DB; boot OK.
2. Crash a session (kill the harness from tmux) → card flips to exited within a sweep tick; terminal page shows "exited (code N)".
3. Auto-restart profile: kill → backoff restart observed (`startedAt` advances); kill repeatedly → backoff grows, caps.
4. Backend restart mid-crash → boot reconcile restores accurate `alive`.
5. WS: kill the tunnel (stop proxy) → reconnecting pill; restore → full transcript replays into the same xterm.
6. `/copy`, `/clear`, `/find`, `/exit` work.
7. Login brute-force: >5 bad attempts → visible delay; correct login resets.
8. Logout → redirected to login; cookie gone. Password change works. User create → new login works; non-admin hitting /api/users → 403.
9. Audit: create/terminate/delete/restart + auth events appear in `GET /api/audit`.
