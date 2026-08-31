# Remote Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mote dependable for operators who are NOT on the box — sessions that survive crashes and backend restarts, a terminal that survives flaky tunnels, and the admin basics (rate-limited auth, logout, password change, user management, audit) for a small team behind a VPN/SSH tunnel.

**Architecture:** Move liveness authority from a transient tmux query to persisted DB flags (`alive`/`exitCode`/`startedAt`/backoff on `sessions`), with the existing 60s reconcile sweep detecting crashes and driving exponential-backoff auto-restarts (same session row). Resilience is mostly client-side: full log replay on every WS connect, an offline pill, and a `/` command bar. Hardening reuses better-auth hooks (rate-limit), routes (signOut/changePassword), and the existing owner/admin route-guard pattern.

**Tech Stack:** bun + Elysia + Kysely + better-auth + tmux 3.6 (backend); React + TanStack Router/Query + xterm (frontend); bun test.

## Global Constraints (from spec / project rules — verbatim)

- Deployment model: VPN/tunnel, **no internet exposure**. Security = trusted-network depth (no lockout/2FA/TLS; deferred).
- All package versions pinned (no `^`/`~`).
- No dynamic imports (`await import(...)`) anywhere.
- API schema properties must include `description` (OpenAPI + Eden client gen).
- Dark-only UI.
- Every Elysia route schema is a named constant, not inline.
- Tests live in `__tests__/` dirs; use `bun test` (not vitest).
- Frontend has no test runner — verify with `bunx tsc --noEmit` + lint + browser smoke.
- After any backend change: `bun run verify-types`, `bun run lint` (per-package), `bun test` (per-package).
- Reconcile sweep (60s + boot) is the **only** writer of `alive`/`exitCode`/`backoff` transitions (plus user terminate/delete/restart).
- Auto-restart keeps the **same session row**; the existing `Restart` button creates a new row.
- Run backend from `apps/backend` dir only (`bun run ./src/index.ts` fails from repo root); dev backend needs restart after edits (`bun run dev` = `--watch`, plain run is stale).

## File Structure

**Backend**
- `apps/backend/src/db/migrations/0003-remote-ops.ts` — sessions + profiles new columns
- `apps/backend/src/db/migrations/0004-auth-audit.ts` — `auth_attempts` + `audit_events` tables
- `apps/backend/src/db/types/sessions.db-types.ts`, `profiles.db-types.ts`, `index.ts` (+ new audit/attempt types)
- `apps/backend/src/db/repositories/` — `sessions.repository.ts` (liveness updates), `users.repository.ts` (new), `audit.repository.ts` (new), `user-meta.repository.ts` (role listing)
- `apps/backend/src/services/session-manager.service.ts` — crash detection, auto-restart backoff, boot reconcile, `toSessionView` (alive/exitCode/startedAt/backoff)
- `apps/backend/src/services/tmux/tmux-runner.ts` — `paneExitCode` helper
- `apps/backend/src/auth.ts` — rate-limit hook, signOut wiring, admin user-creation helper
- `apps/backend/src/api/` — `users.route.ts` (new), `audit.route.ts` (new), `sessions.route.ts` (alive fields), `auth-guard.ts` (admin helper), `models.ts` (schema fields + Audit/User schemas)

**Frontend**
- `apps/frontend/src/routes/sessions.tsx` (manager page — note: this is a NEW file; the existing `sessions.$id.tsx` is the terminal detail)
- `apps/frontend/src/routes/settings.tsx` (password card), `apps/frontend/src/routes/users.tsx` (new)
- `apps/frontend/src/components/session-card.tsx` (alive/exited chip), `sessions.$id.tsx` (dead state, offline pill, command bar)
- `apps/frontend/src/lib/use-session-ws.ts` (reconnect loop + dedupe), `lib/commands.ts` (new)
- `apps/frontend/src/routes/index.tsx` (Logout button, paused section), `types/session.ts` (alive/exitCode)

**Packages**
- `packages/harnesses/src/claude-code.ts` + `types.ts` — `exitStatus?` on HarnessPlugin

**Docs**: README remote section, TODO.md update.

---

### Task 1: Migration 0003 — sessions + profiles liveness columns

**Files:**
- Create: `apps/backend/src/db/migrations/0003-remote-ops.ts`
- Modify: `apps/backend/src/db/migrate.ts`, `apps/backend/src/db/types/sessions.db-types.ts`, `apps/backend/src/db/types/profiles.db-types.ts`
- Test: `apps/backend/src/db/migrations/__tests__/0003-remote-ops.test.ts`

**Interfaces:**
- Consumes: `Kysely<unknown>` migration shape (mirror 0002).
- Produces: `SessionTable` gains `alive: number`, `exitCode: number | null`, `startedAt: string | null`, `backoffCount: number`, `nextRestartAt: string | null`, `restartOnExit: number`. `NewSession` gains optional `alive?: number`. `ProfileTable` gains `restartOnExit: number`. `SessionUpdate` gains the new fields (already `Partial<Omit<...>>`).

- [ ] **Step 1: Write the failing migration + test**

```ts
// apps/backend/src/db/migrations/0003-remote-ops.ts
import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Liveness + auto-restart columns on sessions.
  await db.schema.alterTable("sessions").addColumn("alive", "integer", (c) => c.defaultTo(1)).execute();
  await db.schema.alterTable("sessions").addColumn("exit_code", "integer").execute();
  await db.schema.alterTable("sessions").addColumn("started_at", "text").execute();
  await db.schema.alterTable("sessions").addColumn("backoff_count", "integer", (c) => c.defaultTo(0)).execute();
  await db.schema.alterTable("sessions").addColumn("next_restart_at", "text").execute();
  await db.schema.alterTable("sessions").addColumn("restart_on_exit", "integer", (c) => c.defaultTo(0)).execute();
  // Per-profile default for new sessions.
  await db.schema.alterTable("profiles").addColumn("restart_on_exit", "integer", (c) => c.defaultTo(0)).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const col of ["alive", "exit_code", "started_at", "backoff_count", "next_restart_at", "restart_on_exit"]) {
    await db.schema.alterTable("sessions").dropColumn(col).execute();
  }
  await db.schema.alterTable("profiles").dropColumn("restart_on_exit").execute();
}
```

```ts
// apps/backend/src/db/migrations/__tests__/0003-remote-ops.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect, openSqliteDatabase } from "@internal/sqlite-dialect";
import { up as up003 } from "@/db/migrations/0003-remote-ops.js";

describe("0003 remote-ops migration", () => {
  let dbFile: string;
  let db: Kysely<unknown>;
  beforeAll(async () => {
    dbFile = `/tmp/mote-003-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await db.schema.createTable("sessions").addColumn("id", "text", (c) => c.primaryKey()).execute();
    await db.schema.createTable("profiles").addColumn("id", "text", (c) => c.primaryKey()).execute();
    await up003(db);
  });
  afterAll(() => { Bun.file(dbFile).unlink().catch(() => {}); db.destroy().catch(() => {}); });

  it("adds liveness columns", async () => {
    const row = await db.insertInto("sessions").values({ id: "s1" }).returning(["alive", "exit_code", "started_at", "backoff_count", "next_restart_at", "restart_on_exit"]).executeTakeFirstOrThrow();
    expect(row.alive).toBe(1);
    expect(row.backoff_count).toBe(0);
    expect(row.restart_on_exit).toBe(0);
    expect(row.exit_code).toBeNull();
  });
  it("adds profiles.restart_on_exit", async () => {
    const row = await db.insertInto("profiles").values({ id: "p1" }).returning(["restart_on_exit"]).executeTakeFirstOrThrow();
    expect(row.restart_on_exit).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd apps/backend && bun test src/db/migrations/__tests__/0003-remote-ops.test.ts`
  Expected: FAIL — module not found.

- [ ] **Step 3: Wire the migration + types**

```ts
// apps/backend/src/db/migrate.ts — add import + provider entry (mirror 0002):
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
// getMigrations(): "0003-remote-ops": remoteOpsMigration,
```

```ts
// apps/backend/src/db/types/sessions.db-types.ts — add to SessionTable:
  /** 1 = pane process alive; 0 = dead/paused */
  alive: number;
  /** Harness exit status when it died (null = n/a) */
  exitCode: number | null;
  /** ISO timestamp of the last process start */
  startedAt: string | null;
  /** Consecutive auto-restarts (exponential backoff) */
  backoffCount: number;
  /** ISO timestamp when a backoff-delayed auto-restart is due */
  nextRestartAt: string | null;
  /** 1 = auto-restart this session on unexpected exit */
  restartOnExit: number;
// NewSession: add optional `alive?: number`.
```

```ts
// apps/backend/src/db/types/profiles.db-types.ts — add to ProfileTable:
  /** 1 = new sessions from this profile auto-restart on exit */
  restartOnExit: number;
// NewProfile: add optional `restartOnExit?: number`.
```

- [ ] **Step 4: Run test to verify it passes** — `bun test src/db/migrations/__tests__/0003-remote-ops.test.ts` → PASS.

- [ ] **Step 5: Verify + commit**
  `bun run verify-types` then:
  `git add apps/backend/src/db && git commit -m "feat(db): liveness + auto-restart columns (migration 0003)"`

---

### Task 2: Crash detection + liveness in the session manager

**Files:**
- Modify: `apps/backend/src/services/session-manager.service.ts`, `apps/backend/src/services/tmux/tmux-runner.ts`
- Modify: `apps/backend/src/api/models.ts`, `apps/backend/src/api/sessions.route.ts` (view schema only — no new routes)
- Test: `apps/backend/src/services/__tests__/session-manager.service.test.ts`

**Interfaces:**
- Consumes: Task 1 columns; `TmuxRunner.hasSession(socket, name): boolean`.
- Produces:
  - `TmuxRunner.paneExitCode(socket, sessionName): number | null` — reads tmux 3.6 `#{exit_status}` on the session's main pane; null when not dead/unavailable.
  - `SessionManagerService.reconcileRows` now stamps `alive`/`exitCode`/`startedAt` (crash detection).
  - `SessionView` gains `alive: boolean`, `exitCode: number | null`, `startedAt: string | null`, `backoffCount: number`, `restartOnExit: boolean`, `nextRestartAt: string | null` (drives the "restart pending" UI in Tasks 5-6).
  - `createSession` stamps `startedAt` + `alive: 1` on insert; `terminateSession` + `reconcileRows`-reap set `alive: 0`.

- [ ] **Step 1: Write the failing tests** (add to `__tests__/session-manager.service.test.ts`)

```ts
it("reconcile marks a dead tmux session as not-alive (crash)", async () => {
  const profileId = await seedProfile("u1");
  const id = await seedSession("u1", profileId); // tmuxSocket null → not alive
  await sessionManager.reconcile("u1");
  const row = await sessionsRepo.findById(id);
  expect(row?.alive).toBe(0);
});
```

Also update the existing `terminateSession` assertions to expect `alive: 0` after terminate (row check in the "creates a session" test already reads fields; add `expect(after?.alive).toBe(0)`).

- [ ] **Step 2: Run test to verify it fails** — `bun test src/services/__tests__/session-manager.service.test.ts` → FAIL (`alive` undefined / never set).

- [ ] **Step 3: Implement liveness writes**

```ts
// tmux-runner.ts — add:
  /** Reads the main pane's exit status (tmux 3.6); null when not dead/unknown. */
  paneExitCode(socket: string, sessionName: string): number | null {
    try {
      const out = this.run(["-L", socket, "display-message", "-p", "#{pane_dead}:#{exit_status}"], {});
      const [dead, status] = out.trim().split(":");
      if (dead === "1") return Number(status) || null;
      return null;
    } catch {
      return null;
    }
  }
```
(Note: `display-message -p` with those format vars prints the current pane's values; the session's single pane is `-t` the window's pane. If `exit_status` isn't populated on this tmux, fall back to `null` — the code handles it.)

```ts
// session-manager.service.ts — reconcileRows: replace the current reap block with:
  private async reconcileRows(rows: SessionTable[]): Promise<void> {
    const now = new Date().toISOString();
    for (const row of rows) {
      if (!row.tmuxSocket) {
        // No socket → cannot be alive; mark crashed so reconcile converges.
        if (row.status === "running" && row.alive === 1) {
          await this.#sessions.update(row.id, { alive: 0 });
          logger.info(`session process absent (no socket): ${row.id}`);
        }
        continue;
      }
      if (!this.#tmux.hasSession(row.tmuxSocket, row.id)) {
        if (row.alive === 1) {
          const exitCode = this.#tmux.paneExitCode(row.tmuxSocket, row.id);
          await this.#sessions.update(row.id, { alive: 0, exitCode });
          logger.info(`session crashed (exit=${exitCode ?? "?"}): ${row.id}`);
        }
        continue;
      }
      // Alive: stamp liveness + fold in the existing lastOutputAt mtime logic.
      const patch: SessionUpdate = { alive: 1, startedAt: row.startedAt ?? now };
      // (keep the existing mtime-based lastOutputAt stamping from the previous round)
      try {
        const mtimeMs = (await Bun.file(sessionLogPath(row.id)).stat()).mtime.getTime();
        if (!row.lastOutputAt || mtimeMs > new Date(row.lastOutputAt).getTime()) {
          patch.lastOutputAt = new Date(mtimeMs).toISOString();
        }
      } catch { /* no log yet */ }
      await this.#sessions.update(row.id, patch);
    }
  }
```
(Import `SessionUpdate` type. `markTerminated` is still used by `terminateSession` — also set `alive: 0` there: after `markTerminated`, `await this.#sessions.update(row.id, { alive: 0 })` or add to the repo method.)

```ts
// session-manager.service.ts — createSession: stamp startedAt + alive on insert:
      alive: 1,
      startedAt: new Date().toISOString(),
      // (keep lastOutputAt stamping)
```
```ts
// terminateSession (service): after markTerminated, ensure alive: 0:
    await this.#sessions.markTerminated(id, new Date().toISOString());
    await this.#sessions.update(id, { alive: 0 });
```

- [ ] **Step 4: Schema + view**

```ts
// models.ts SessionSchema — add:
  alive: t.Number({ description: "1 = pane process alive; 0 = crashed/paused" }),
  exitCode: t.Union([t.Number({ description: "Harness exit status" }), t.Null()]),
  startedAt: t.Union([t.String({ description: "Last process start (ISO)" }), t.Null()]),
  backoffCount: t.Number({ description: "Consecutive auto-restarts" }),
  restartOnExit: t.Number({ description: "1 = auto-restart on exit" }),
  nextRestartAt: t.Union([t.String({ description: "Backoff restart due (ISO)" }), t.Null()]),
```
```ts
// toSessionView — add:
    alive: row.alive === 1,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    backoffCount: row.backoffCount,
    restartOnExit: row.restartOnExit === 1,
    nextRestartAt: row.nextRestartAt,
```

- [ ] **Step 5: Run tests + verify** — `bun test` (74 exist + new) and `bun run verify-types`. Fix the type of the view + the new test seeds (`seedSession` needs `tmuxSocket: null` → the reconcile "no socket" path).
  Expected: all pass.

- [ ] **Step 6: Commit** — `git add apps/backend/src && git commit -m "feat: persisted liveness — crash detection in reconcile (alive/exitCode)"`

---

### Task 3: Auto-restart with exponential backoff

**Files:**
- Modify: `apps/backend/src/services/session-manager.service.ts`
- Modify: `apps/backend/src/api/models.ts` (ProfileSchema restartOnExit + Session fields), `apps/backend/src/db/repositories/profiles.repository.ts` (create/update accept the field)
- Test: `apps/backend/src/services/__tests__/session-manager.service.test.ts`

**Interfaces:**
- Consumes: Task 1-2 (`alive`, `backoffCount`, `nextRestartAt`, `restartOnExit`, `parseProfile`).
- Produces: auto-restart driven by reconcile; `parseProfile` returns `{ ..., restartOnExit: boolean }`; profiles route accepts `restartOnExit`.

- [ ] **Step 1: Write the failing test**

```ts
it("auto-restarts a restart_on_exit session after backoff, same row", async () => {
  const profileId = await seedProfile("u1"); // real profile (createSession re-validates + spawns tmux)
  await profilesRepo.update(profileId, { restartOnExit: 1 });
  const created = await sessionManager.createSession({ userId: "u1", profileId, workspacePath: "/tmp" });
  const id = created.id;
  // Simulate a crash: mark the tmux dead + set a past backoff.
  await sessionsRepo.update(id, { alive: 0, exitCode: 1, backoffCount: 0, nextRestartAt: new Date(Date.now() - 1000).toISOString() });
  await sessionManager.reconcileAll();
  const after = await sessionsRepo.findById(id);
  expect(after?.alive).toBe(1);          // restarted
  expect(after?.backoffCount).toBe(1);   // incremented
  // Also: no restart when backoff not yet due.
  await sessionsRepo.update(id, { alive: 0, nextRestartAt: new Date(Date.now() + 60_000).toISOString() });
  await sessionManager.reconcileAll();
  expect((await sessionsRepo.findById(id))?.alive).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test src/services/__tests__/session-manager.service.test.ts` → FAIL (nothing restarts).

- [ ] **Step 3: Implement**

```ts
// session-manager.service.ts — new private method + hook in reconcileRows:

  /** Exponential-backoff auto-restart for crashed sessions (same DB row). */
  private async maybeAutoRestart(row: SessionTable): Promise<boolean> {
    if (row.status !== "running" || row.alive === 1 || row.restartOnExit !== 1) return false;
    const now = Date.now();
    if (row.nextRestartAt && new Date(row.nextRestartAt).getTime() > now) return false; // backoff pending
    const delayMs = Math.min(30_000 * 2 ** row.backoffCount, 480_000);
    if (row.backoffCount >= 5) {
      logger.warn(`session ${row.id}: auto-restart backoff limit reached`);
      return false;
    }
    await this.#sessions.update(row.id, { nextRestartAt: new Date(now + delayMs).toISOString() });
    try {
      const profileRow = await this.#profiles.findById(row.profileId);
      if (!profileRow) throw new Error("profile missing");
      const harness = getHarness(row.harnessId);
      if (!harness) throw new Error("harness missing");
      const realPath = await validateWorkspacePath(row.workspacePath);
      const binary = await harness.findBinary();
      if (!binary) throw new Error("harness binary missing");
      const profile = parseProfile(profileRow);
      const cmd = buildHarnessCommand(harness, binary, realPath, profile, row.name);
      const socket = row.tmuxSocket ?? tmuxSocketFor(row.id);
      this.#tmux.newSession(socket, row.id, realPath, cmd);
      // Re-attach the log pipe if it was unlinked by cleanup.
      const logFile = sessionLogPath(row.id);
      await this.#sessions.update(row.id, { alive: 1, startedAt: new Date().toISOString(), backoffCount: row.backoffCount + 1, nextRestartAt: null });
      try { this.#tmux.pipePane(socket, row.id, logFile); } catch { /* best-effort */ }
      logger.info(`session auto-restarted (${row.id}), backoff=${row.backoffCount + 1}`);
      return true;
    } catch (err) {
      logger.withError(err).warn(`auto-restart failed for ${row.id}`);
      await this.#sessions.update(row.id, { nextRestartAt: null }); // retry next sweep
      return false;
    }
  }
```
And in `reconcileRows`, dead branch: after stamping `alive: 0` + `exitCode`, `await this.maybeAutoRestart(row)` (row snapshot already has restartOnExit + backoffCount). In the alive branch, if `row.alive === 1 && row.backoffCount > 0` after a "healthy" tick, reset `backoffCount: 0` (define healthy = alive at sweep).

```ts
// parseProfile — add: restartOnExit: row.restartOnExit === 1,
```
```ts
// profiles.repository.ts create/update — the field is in ProfileTable; NewProfile gains `restartOnExit?: number`.
// models.ts ProfileSchema — add: restartOnExit: t.Number({ description: "1 = new sessions auto-restart on exit" }),
```

- [ ] **Step 4: Run tests + verify** — `bun test`, `bun run verify-types`. Expected: all pass (auto-restart test uses real tmux; ensure `createSession` leaves the pane alive long enough for the reconcile assertions — if flaky, assert `alive` only after a timed restart instead of immediate).
  If the "restart" doesn't spawn because the harness binary is missing on this host, stub `findBinary` via the existing `ClaudeCodePlugin(binaryOverride)` pattern (point at `/bin/true`-like shell) OR assert the `nextRestartAt` bookkeeping instead.

- [ ] **Step 5: Commit** — `git add apps/backend/src && git commit -m "feat: exponential-backoff auto-restart on unexpected exit"`

---

### Task 4: Exit-status mapping in the harness plugin

**Files:**
- Modify: `packages/harnesses/src/types.ts`, `packages/harnesses/src/claude-code.ts`
- Test: `packages/harnesses/src/__tests__/harnesses.test.ts` (or a new `claude-code.test.ts`)

**Interfaces:**
- Consumes: nothing.
- Produces: optional `HarnessPlugin.exitStatus?(code: number): string | null`; `ClaudeCodePlugin.exitStatus` mapping known CLI exit codes to labels (e.g. `10` → "closed-loop complete", `1` → "error doing work", `5` → "permissions denied", default null). `toSessionView` uses it later (Task 5).

- [ ] **Step 1: Write the failing test**

```ts
import { ClaudeCodePlugin } from "../claude-code.js";
describe("ClaudeCodePlugin.exitStatus", () => {
  const p = new ClaudeCodePlugin();
  it("maps known codes", () => {
    expect(p.exitStatus?.(10)).toContain("loop");
    expect(p.exitStatus?.(1)).toContain("error");
    expect(p.exitStatus?.(5)).toContain("permission");
  });
  it("returns null for unknown", () => {
    expect(p.exitStatus?.(999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/harnesses && bun test` → FAIL (`exitStatus` undefined).

- [ ] **Step 3: Implement**

```ts
// types.ts — add to HarnessPlugin:
  /** Maps a harness exit code to a human label (null = unknown). */
  exitStatus?(code: number): string | null;
```
```ts
// claude-code.ts — add:
  exitStatus(code: number): string | null {
    const map: Record<number, string> = {
      1: "error doing work",
      5: "permissions denied",
      10: "closed-loop complete",
      11: "gate closed",
    };
    return map[code] ?? null;
  }
```

- [ ] **Step 4: Run tests + verify** — `bun test` (harnesses 7 + new) → PASS; `bun run verify-types`.

- [ ] **Step 5: Commit** — `git add packages/harnesses && git commit -m "feat(harnesses): claude-code exit status labels"`

---

### Task 5: Frontend — session model + exited/backoff UI + session manager page

**Files:**
- Modify: `apps/frontend/src/types/session.ts`, `apps/frontend/src/components/session-card.tsx`, `apps/frontend/src/routes/index.tsx`
- Create: `apps/frontend/src/routes/sessions.tsx`, `apps/frontend/src/components/session-manager-table.tsx`
- Test: none (frontend); verify `bunx tsc --noEmit` + lint + browser smoke.

**Interfaces:**
- Consumes: `SessionView` now includes `alive: boolean`, `exitCode: number | null`, `startedAt: string | null`, `backoffCount: number`, `restartOnExit: boolean`, `preview: string[]`.
- Produces: home page 3-section layout (Running=Paused/Completed), manager page at `/sessions` with the full table + bulk actions.

- [ ] **Step 1: Type + card + home**

```ts
// types/session.ts — extend SessionView:
  alive: boolean;
  exitCode: number | null;
  startedAt: string | null;
  backoffCount: number;
  restartOnExit: boolean;
  nextRestartAt: string | null;
```
```tsx
// session-card.tsx — derive a label/chip:
  const exited = session.status === "running" && !session.alive;
  // Badge: exited ? "exited" : ACTIVITY_LABEL[session.activity]
  // CardContent: add {exited && <p className="truncate text-xs text-muted-foreground">
  //   exit: {session.exitCode != null ? `${session.exitCode}${label ? ` (${label})` : ""}` : "no exit code"}
  //   {session.backoffCount > 0 && ` · restart ${session.backoffCount}`}</p>}
```
```tsx
// routes/index.tsx — split the running section:
  const running = filtered.filter((s) => s.status === "running" && s.alive);
  const paused = filtered.filter((s) => s.status === "running" && !s.alive);
  // render: Running grid (as today), Paused section (muted cards, no preview),
  // Completed section (terminated, keep as today).
  // Add a header link "Manage" → /sessions (or replace the "Completed" grid with a "View all → /sessions" link).
```

- [ ] **Step 2: Manager page**

```tsx
// apps/frontend/src/routes/sessions.tsx:
import { createFileRoute } from "@tanstack/react-router";
import { useLiveSessions } from "@/hooks/useLiveSessions";
import { SessionManagerTable } from "@/components/session-manager-table";
export const Route = createFileRoute("/sessions")({ component: SessionsManagerPage });
function SessionsManagerPage() {
  const { sessions } = useLiveSessions();
  return (
    <main className="mx-auto w-full max-w-6xl p-6">
      <h1 className="mb-4 font-bold text-2xl">Sessions</h1>
      <SessionManagerTable sessions={sessions} />
    </main>
  );
}
```

```tsx
// apps/frontend/src/components/session-manager-table.tsx:
// Table (shadcn/ui table or plain): columns = select checkbox, name, status (chip: running/working,
//   paused-exited, terminated), workspace, lastOutputAt (relative), uptime (from startedAt), backoff, actions.
// Bulk actions bar (when ≥1 selected): Terminate | Restart | Delete → loop the existing
//   endpoints per id (`POST /:id/terminate`, `POST /:id/restart`, `DELETE /:id`) with
//   confirm() once for the batch, then invalidate ["sessions"].
// Row actions: Terminate / Restart / Delete (per row, small buttons).
```

- [ ] **Step 3: Verify + commit** — `cd apps/frontend && bunx tsc --noEmit && bun run lint`; browser smoke: home shows exited chip; /sessions table renders + bulk delete removes rows (SSE refresh).
  `git add apps/frontend/src && git commit -m "feat: session manager page + exited/backoff chips (alive-aware home)"`

---

### Task 6: Terminal page — exited state, offline pill, restart-alive UI

**Files:**
- Modify: `apps/frontend/src/routes/sessions.$id.tsx`

**Interfaces:**
- Consumes: `SessionView.alive/exitCode/backoffCount/nextRestartAt` (Task 2 adds them to the view); existing `useSessionWs` handlers.
- Produces: dead-session UX ("Session exited (code N) — Restart / Delete"), an offline/reconnecting pill, and a "paused" banner while a backoff restart is pending (from `nextRestartAt`/`backoffCount`).

- [ ] **Step 1: Implement terminal page states**

```tsx
// sessions.$id.tsx — replace the `closed` block with a states renderer:
  const exited = session?.status === "running" && session?.alive === false;
  // closed (ws closed abnormally) → existing "Session is not running."
  // exited → render: "Session exited {exitCode != null ? `(code ${exitCode}${label ? ` — ${label}` : ""})` : ""}"
  //   + Restart button (new row, as today) + Delete button (DELETE /:id → navigate("/"))
  // alive but ws-down → keep terminal mounted + show "reconnecting…" pill (see Task 7 for the loop).
  // backoffCount > 0 → subtle "(restart #{backoffCount} pending)" text near the status badge.
```

- [ ] **Step 3: Verify + commit** — `bunx tsc --noEmit`, lint, smoke: terminate a session → exited state + buttons work.
  `git add apps/frontend/src/routes/sessions.$id.tsx && git commit -m "feat: terminal page exited/dead + restart/delete + backoff status"`

---

### Task 7: WS reconnect loop + offline pill (remote-resilience)

**Files:**
- Modify: `apps/frontend/src/lib/use-session-ws.ts`

**Interfaces:**
- Consumes: existing `TermWsHandlers` (`onOpen/onClose/onError/onFrame`).
- Produces: automatic reconnect with full replay into the SAME xterm; `onClose` fires with a `sticky` code so the page can show reconnecting/offline.

- [ ] **Step 1: Write the reconnect loop** (replace the single `connect()` with a retry loop)

```ts
    // inside useEffect, replace `void connect()` with:
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRetry = (delayMs: number) => {
      if (cancelled) return;
      retryTimer = setTimeout(() => void connect(), delayMs);
    };
    // connect() gains: on ws.onclose: if (!cancelled) scheduleRetry(1500); (keep firing onClose to the page)
    // ws.onerror: scheduleRetry(1500) as well (don't double: guard with a flag or keep onclose authoritative).
    // on the `replay` frame: term.write (as today) — the log tail re-streams from 0 every attach,
    // so replay + full tail together reconstruct full history on reconnect.
    // Dedupe: `replay` should not append to the transcript twice — reset a `replayedRef` flag per connect.
    // Cleanup: cancel retryTimer.
```
Also pass a `manual` escape: expose the wsRef (already returned) so the page can `.close()` cleanly on unmount.

- [ ] **Step 2: Verify** — `bunx tsc --noEmit`, lint. Browser smoke (tunnel-drop simulation): kill the frontend proxy / stop the backend → pill shows; restart backend → transcript fully replays.
  `git add apps/frontend/src/lib/use-session-ws.ts && git commit -m "fix: auto-reconnect WS with full replay + dedupe"`

---

### Task 8: Command bar (`/` palette)

**Files:**
- Create: `apps/frontend/src/lib/commands.ts`
- Modify: `apps/frontend/src/routes/sessions.$id.tsx`

**Interfaces:**
- Consumes: `transcriptRef`, `termRef`, existing `TranscriptSearch`.
- Produces: `/` opens a small input overlay; commands trigger client-side actions.

- [ ] **Step 1: Implement the palette**

```ts
// lib/commands.ts:
export type Command = { name: string; hint: string; run: (ctx: CommandCtx) => void };
export interface CommandCtx {
  term: import("@xterm/xterm").Terminal;
  transcript: string;
  copyText(text: string): Promise<void>;
  openFind(q: string): void;
  sendCtlD(): void;
}
export const COMMANDS: Command[] = [
  { name: "help", hint: "list commands", run: (ctx) => {} /* render list into term */ },
  { name: "copy", hint: "copy transcript", run: async (ctx) => { await ctx.copyText(ctx.transcript); } },
  { name: "clear", hint: "clear terminal", run: (ctx) => { ctx.term.clear(); } },
  { name: "find", hint: "find in terminal (open search)", run: (ctx) => { const q = parseFindArg(); ctx.openFind(q); } },
  { name: "exit", hint: "send Ctrl-D to the session", run: (ctx) => { ctx.sendCtlD(); } },
];
```
- [ ] **Step 2: Wire into sessions.$id.tsx** — a small `CommandBar` component (input with `/` prefix state, on Enter runs the command, always reverts to terminal input). `/help` output uses `term.write` lines. Escape cancels.
- [ ] **Step 3: Verify + commit** — tsc, lint, smoke: `/clear` clears, `/find x` opens search, `/exit` sends Ctrl-D (session exits), `/copy` writes clipboard.
  `git add apps/frontend/src && git commit -m "feat: / command palette (copy, clear, find, exit, help)"`

---

### Task 9: Rate-limited auth + logout (trusted-network hardening)

**Files:**
- Create: `apps/backend/src/db/migrations/0004-auth-audit.ts` (auth_attempts + audit_events), `apps/backend/src/api/auth-rate-limit.route.ts`
- Modify: `apps/backend/src/api/routes.ts` (mount rate-limit route BEFORE the auth passthrough + mount audit route), `apps/backend/src/db/types/index.ts`
- Test: `apps/backend/src/api/__tests__/auth-rate-limit.test.ts` (or inline with the migration test)

**Interfaces:**
- Consumes: `setAuthPolicyDb(db)` (existing injection point), `auth.handler` (better-auth request handler).
- Produces: `auth_attempts` repository helper (insert/record/clear/delay) + an Elysia route that wraps `POST /api/auth/sign-in/email`.
- **Note (verified):** better-auth 1.7.1 with bun 1.x has NO `emailAndPassword.signIn.before` hook API (removed in bun's bundling of the global hooks). The rate limit is implemented as an Elysia route wrapper, not an auth hook.

- [ ] **Step 1: Migration 0004**

```ts
// migrations/0004-auth-audit.ts:
up: create table auth_attempts (email TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT NOT NULL);
     create table audit_events (id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL);
down: drop both.
// Wire into migrate.ts + add to db/types/index.ts Database interface.
```

- [ ] **Step 2: Rate-limit route (Elysia wrapper)**

```ts
// apps/backend/src/api/auth-rate-limit.route.ts
import { Elysia } from "elysia";
import { auth } from "@/auth.js";
import { appDb } from "@/db/index.js"; // the app DB (auth_attempts table)
// (appDb is the same DB better-auth writes; use the app Kysely instance)

async function authDelayMs(email: string): Promise<number> {
  const row = await appDb.selectFrom("auth_attempts").select("attempt_count").where("email", "=", email).executeTakeFirst();
  if (!row?.attempt_count) return 0;
  return Math.min(30_000, 2 ** row.attempt_count * 1000);
}
async function recordFailedLogin(email: string): Promise<void> {
  // upsert: attempt_count = attempt_count + 1 on conflict
}
async function clearAuthAttempts(email: string): Promise<void> {
  // delete row
}

/** Wraps better-auth's email sign-in with an exponential backoff delay. */
export const authRateLimitRoutes = new Elysia().post("/api/auth/sign-in/email", async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = (body?.email ?? "").toLowerCase();
  const delay = await authDelayMs(email);
  if (delay) await Bun.sleep(delay);
  const res = await auth.handler(request); // forward to better-auth (returns Response)
  if (res.status === 401) {
    await recordFailedLogin(email);
  } else if (res.ok && body?.email) {
    await clearAuthAttempts(email);
  }
  return res;
});
```
```ts
// routes.ts — mount authRateLimitRoutes BEFORE the existing auth passthrough
//   (`app.all("/api/auth/*", ...)`), so the wrapper wins the route match.
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
// app.use(authRateLimitRoutes) before the auth .all(...)
```
(If `appDb` isn't exported from `@/db/index.js`, export it or use `setAuthPolicyDb`'s injected reference via a getter.)

- [ ] **Step 3: Logout**

```ts
// auth.ts — expose: export async function signOutUser(headers: Headers) { return auth.api.signOut({ headers }); }
// frontend routes/index.tsx — add a Logout button in the header:
async function logout() {
  await apiFetch("/api/auth/sign-out", { method: "POST" }); // better-auth sign-out route is /api/auth/sign-out
  queryClient.clear();
  window.location.href = "/login";
}
```
- [ ] **Step 4: Test + verify** — migration test (0004 tables exist), plus a unit test for `authDelayMs` (0 → 1s → 2s cap). `bun test`, `verify-types`, lint. Live: 6 bad logins → visible delay on the 6th; good login resets.
- [ ] **Step 5: Commit** — `git add apps/backend/src && git commit -m "feat: rate-limited auth (backoff delay) + logout"`

---

### Task 10: Password change + user management (admin)

**Files:**
- Create: `apps/backend/src/db/repositories/users.repository.ts`, `apps/backend/src/api/users.route.ts`, `apps/backend/src/api/audit.route.ts`, `apps/frontend/src/routes/users.tsx`
- Modify: `apps/backend/src/api/routes.ts` (mount), `apps/backend/src/api/auth-guard.ts` (`requireAdmin`), `apps/frontend/src/routes/settings.tsx`
- Test: `apps/backend/src/api/__tests__/users-admin.test.ts`

**Interfaces:**
- Consumes: `hashPassword` from `better-auth/crypto` (as in `scripts/set-admin-password.ts`), `UserMetaRepository`, `appDb`.
- Produces:
  - `GET /api/users` (admin) → `[{ id, email, role, createdAt }]`
  - `POST /api/users` (admin) body `{ email, password, role }` → creates credential account (id via crypto.randomUUID), hashed password into `account` table, `user_meta` role row.
  - `GET /api/audit?limit=50` (admin) → `[{ id, actorUserId, action, targetType, targetId, metadata, createdAt }]`
  - `requireAdmin` guard (returns 403 response for non-admin).
  - `auth-guard.ts` — extend the existing guard to also attach `user.role` so routes can check it (or `requireAdmin` reads `UserMetaRepository` directly).

- [ ] **Step 1: Repos + guard**

```ts
// users.repository.ts:
export class UsersRepository extends BaseRepository {
  /** Lists users with their role (app user + user_meta join). */
  async listWithRoles(): Promise<{ id: string; email: string; role: string | null; createdAt: string | null }[]> {
    return this.db.selectFrom("user as u").leftJoin("userMeta as m", "m.userId", "u.id")
      .select(["u.id", "u.email", "m.role", "u.createdAt"]).execute() as any;
  }
  /** Inserts a credential account + app user row (used by POST /api/users). */
  async createUser(input: { email: string; passwordHash: string; role: "admin" | "user" }): Promise<string> { /* ... */ }
}
```
(Note: better-auth's `user`/`account` tables are in the same DB — use raw SQL or Kysely against them; mirror the set-admin-password script's `account` inserts.)

- [ ] **Step 2: Audit repo + route**

```ts
// audit.repository.ts: create(event), listLatest(limit)
// audit.route.ts: GET /api/audit (admin)
```
- [ ] **Step 3: Users route + guard**

```ts
// auth-guard.ts — add requireAdmin either by reading user_meta via UserMetaRepository
//   (route: GET /api/users, POST /api/users; 403 when role !== 'admin')
// users.route.ts: as above.
```
- [ ] **Step 4: Frontend**

```tsx
// settings.tsx — add a "Change password" card → POST /api/auth/change-password { currentPassword, newPassword }
//   (better-auth route), success/error inline.
// users.tsx — admin-only page (403 message otherwise): table + "Add user" form (email/password/role select).
//   POST /api/users then invalidate.
```
- [ ] **Step 5: Tests + verify** — `users-admin.test.ts`: create user via repo → login works; foreign/non-admin GET /api/users → 403. Run `bun test`, `verify-types`, lint. Browser smoke: settings password change; users page add + login as new user.
- [ ] **Step 6: Commit** — `git add apps/backend/src apps/frontend/src && git commit -m "feat: password change, admin user management, audit log endpoint"`

---

### Task 11: Boot reconcile + README remote docs + final sweep

**Files:**
- Modify: `apps/backend/src/index.ts` (immediate reconcileAll after startServer), `README.md`, `TODO.md`

**Interfaces:**
- Consumes: `SessionManagerService.reconcileAll`.
- Produces: liveness restored at boot; docs.

- [ ] **Step 1: Boot reconcile**

```ts
// index.ts — after startServer:
  await manager.reconcileAll(); // restore alive/exit state after a backend restart
```

- [ ] **Step 2: README remote section**

```markdown
## Remote / trusted-network operation
- Bind `HOST=0.0.0.0` and set `APP_BASE_URL=https://<your-vpn-host>` +
  `TRUSTED_ORIGINS=<origin>` (comma list).
- Recommended: keep it behind WireGuard/Tailscale/SSH tunnel — the service is
  hardened for trusted networks (rate-limited login, per-user accounts) but is
  NOT internet-grade (no TLS enforcement/2FA); see .claude/rules/security-context.md.
- `GET /api/audit?limit=50` (admin) lists audit events.
```

- [ ] **Step 3: Full verification** — `bun install`, `bun run verify-types` (6 pkgs), per-package lint + `bun test` (backend ≥74, sqlite-dialect 5, harnesses ≥8). Frontend: `bunx tsc --noEmit` + lint + `bun run --cwd apps/frontend build`.
- [ ] **Step 4: End-to-end smoke** (the spec's checklist): migration boot; crash a session → exited card; auto-restart with backoff; backend-restart → boot reconcile restores; tunnel drop → reconnecting pill + full replay; `/` commands; brute-force delay; logout; password change; user create + login; non-admin 403; audit events. Note any flakiness in TODO.md.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: remote operations — boot reconcile + docs + full sweep"`
- [ ] **Step 6: Update TODO.md** with the completed round + any deferred notes (cost tracking still deferred; internet hardening deferred).

---
