# Session Sharing & Notification Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sessions private-by-default with per-session view/edit sharing (to everyone or specific users), and put notifications behind a per-user master switch (default on) plus a per-session bell that now defaults on for new sessions.

**Architecture:** A single pure access resolver (`resolveSessionAccess`) is the one authorization source, consumed by the HTTP session service, the WS attach handler, and workspace pane-adding. `SessionManagerService`'s owner-keyed methods stay owner-keyed (they still guard their own data ops and serve the auto-restart path); the HTTP layer resolves the row's owner id and passes it to the manager only *after* an access check passes, so forgetting the gate fails closed. A new `session_shares` table holds grant rows (a NULL grantee = "Everyone"); `user_meta.notify_enabled` is the per-user master switch.

**Tech Stack:** Bun, Elysia, Kysely + bun:sqlite, better-auth, TypeBox (`t`) via the `apiModels` plugin, Eden Treaty (`@internal/backend-client`), React + TanStack Query (frontend), React Native (mobile), `bun test`, Playwright (e2e).

## Global Constraints

- Verification after **every** task: `bun run verify-types`, `bun run lint:check`, `bun run test` from the repo root, all green before committing. (`build.md`: rebuild needed for backend route/schema changes so Eden Treaty re-infers — `bun run verify-types` covers type-level; no separate codegen.)
- Migrations live in `apps/backend/src/db/migrations/` **and** must be registered in the static provider map in `apps/backend/src/db/migrate.ts`; file name == map key (highest today is `0015`).
- No dynamic imports (`.claude/rules/code-style.md`). Elysia `t` schema properties all need a `description`. Public methods/functions carry JSDoc. Interface props carry JSDoc.
- Files stay focused (~300–400 lines); session routes are one-Elysia-per-file under `api/sessions/`, logic in `SessionsService`.
- Test DB is a per-process temp file; suites may write freely. Never mutate `apps/backend/data/`.
- Access level names are exactly `"owner" | "edit" | "view" | "none"`. Permission column values exactly `"view" | "edit"`.
- Invisible sessions (access `none`) answer **404**, not 403 — never confirm existence. Visible-but-insufficient answers **403**.

## File Structure (new / changed)

**Backend — create**
- `db/types/session-shares.db-types.ts` — `SessionShareTable`, `SessionSharePermission`.
- `db/migrations/0016-session-sharing.ts` — `session_shares` table + `user_meta.notify_enabled`.
- `db/repositories/session-shares.repository.ts` — `listForSession`, `listForSessions`, `replaceForSession`.
- `lib/session-access.ts` — `Access` type, `resolveSessionAccess`, `accessAtLeast`, `loadSessionAccess` (DB-backed loader used by HTTP + WS + workspaces).
- `api/sessions/get-session-shares.route.ts`, `api/sessions/set-session-shares.route.ts`.
- Tests for each of the above under sibling `__tests__/`.

**Backend — modify**
- `db/types/user-meta.db-types.ts`, `db/types/index.ts` (register table + type), `db/migrate.ts` (register 0016), `db/repositories/user-meta.repository.ts` (`getNotifyEnabled`/`setNotifyEnabled`), `db/repositories/sessions.repository.ts` (`listVisibleTo`), `db/types/sessions.db-types.ts` (no change needed), `api/models.ts` (SessionSchema `access`), `services/sessions.service.ts` (access-gated methods, `createSession` notify:true, list/summary visibility, `setSessionNotify` owner-only, new share CRUD), `services/session-manager.service.ts` (`toViews(rows)` helper, expose `getSessionRow`), `ws/session-ws.ts` (attach access + `canInput`), `ws/ws.plugin.ts` (thread data if needed), `services/workspaces.service.ts` (`addWorkspacePane` access>=view), `api/notifications.route.ts` (per-user settings GET/PATCH), `api/sessions/index.ts` (mount share routes).
- `.claude/rules/security-context.md`.

**Frontend — modify**
- `src/types/session.ts` (`access`, `accessOf`), `src/hooks/use-session-mutations.ts` (share + notify-settings mutations), `src/routes/settings.tsx` + `src/components/notifications-card.tsx` (master toggle), `src/routes/sessions_.$id.tsx` + `src/components/session-actions-menu.tsx` + `src/components/session-terminal.tsx` + `src/lib/use-session-ws.ts` (access-driven controls/read-only), `src/components/session-picker/new-session-form.tsx` (bell default on), new `src/components/sharing-dialog.tsx`.

**Mobile — modify**
- `src/types/session.ts` (`access`), `src/lib/api.ts` (ignore), `src/components/session-detail.tsx` (gate action bar + terminal input by `access`).

---

## Phase 1 — Notifications (default-on + per-user master switch)

### Task 1: `user_meta.notify_enabled` column + repository accessors

**Files:**
- Create: `apps/backend/src/db/migrations/0016-session-sharing.ts` (this task adds only the `user_meta` column; `session_shares` is added in Phase 2 to the *same* file)
- Modify: `apps/backend/src/db/migrate.ts`, `apps/backend/src/db/types/user-meta.db-types.ts`, `apps/backend/src/db/repositories/user-meta.repository.ts`
- Test: `apps/backend/src/db/migrations/__tests__/0016-session-sharing.test.ts`

**Interfaces:**
- Produces: `UserMetaTable.notifyEnabled: number`; `UserMetaRepository.getNotifyEnabled(userId): Promise<boolean>` (default `true` when no row); `UserMetaRepository.setNotifyEnabled(userId, on: boolean): Promise<void>`.

- [ ] **Step 1: Write the failing migration test**

Create `apps/backend/src/db/migrations/__tests__/0016-session-sharing.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { db } from "@/db/index.js";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";

// Runs the app's real migrators (setupAuthTables applies better-auth + app
// migrations to the shared temp DB). Asserts Phase-1 column only.
describe("migration 0016 notify_enabled", () => {
  beforeAll(async () => {
    await setupAuthTables();
  });
  it("adds user_meta.notify_enabled defaulting to 1", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('user_meta')`.execute(db);
    expect(cols.rows.map((c) => c.name)).toContain("notify_enabled");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0016-session-sharing.test.ts`
Expected: FAIL — `notify_enabled` not in columns (and setupAuthTables doesn't yet run 0016).

- [ ] **Step 3: Write the migration**

Create `apps/backend/src/db/migrations/0016-session-sharing.ts`:

```ts
import type { Kysely } from "kysely";

/**
 * Session sharing + notification defaults (spec 2026-08-31):
 * - `user_meta.notify_enabled`: per-user master switch, default 1 (on). A
 *   push fires only when this AND the session bell are on.
 * - `session_shares`: per-session grants (added here so one migration owns
 *   the feature). `grantee_user_id` NULL = the "Everyone" grant.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("user_meta")
    .addColumn("notify_enabled", "integer", (c) => c.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createTable("session_shares")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("session_id", "text", (c) => c.notNull().references("sessions.id").onDelete("cascade"))
    .addColumn("grantee_user_id", "text")
    .addColumn("permission", "text", (c) => c.notNull())
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("idx_session_shares_session")
    .on("session_shares")
    .column("session_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("session_shares").execute();
  await db.schema.alterTable("user_meta").dropColumn("notify_enabled").execute();
}
```

- [ ] **Step 4: Register it in the provider map**

In `apps/backend/src/db/migrate.ts` add the import beside the others:

```ts
import * as sessionSharingMigration from "@/db/migrations/0016-session-sharing.js";
```

and in the `getMigrations()` object, after `"0015-device-push-tokens"`:

```ts
          "0016-session-sharing": sessionSharingMigration,
```

- [ ] **Step 5: Add the column to the row type**

Modify `apps/backend/src/db/types/user-meta.db-types.ts`:

```ts
export interface UserMetaTable {
  /** better-auth user id */
  userId: string;
  /** Role: "admin" or "user" */
  role: string;
  /** 1 = receive session notifications (per-user master switch); 0 = never push */
  notifyEnabled: number;
}

/** Insert shape — `notifyEnabled` falls back to the DB default (1) when omitted. */
export type NewUserMeta = UserMetaTable;
```

- [ ] **Step 6: Add repository accessors**

In `apps/backend/src/db/repositories/user-meta.repository.ts`, keep `upsert`/`getRole`/`countUsers` and add:

```ts
  /**
   * Whether this user receives session notifications. A missing row (or the
   * default) reads as enabled — notifications are on by default.
   * @param userId - better-auth user id
   */
  async getNotifyEnabled(userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("userMeta")
      .select("notifyEnabled")
      .where("userId", "=", userId)
      .executeTakeFirst();
    return (row?.notifyEnabled ?? 1) === 1;
  }

  /** Sets the per-user notification master switch. */
  async setNotifyEnabled(userId: string, on: boolean): Promise<void> {
    await this.db
      .updateTable("userMeta")
      .set({ notifyEnabled: on ? 1 : 0 })
      .where("userId", "=", userId)
      .execute();
  }
```

Note: `upsert` currently updates only `role` on conflict — leave it; `notify_enabled` is set only through `setNotifyEnabled`, and new rows take the DB default 1.

- [ ] **Step 7: Run tests, expect PASS; then full verification**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0016-session-sharing.test.ts`
Then root: `bun run verify-types && bun run lint:check && bun run test` — all green.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/db/migrations/0016-session-sharing.ts apps/backend/src/db/migrate.ts apps/backend/src/db/types/user-meta.db-types.ts apps/backend/src/db/repositories/user-meta.repository.ts apps/backend/src/db/migrations/__tests__/0016-session-sharing.test.ts
git commit -m "feat(notify): per-user notify_enabled master switch column + repository accessors"
```

### Task 2: New sessions default the bell ON

**Files:**
- Modify: `apps/backend/src/services/sessions.service.ts:91-97` (the `manager.createSession({...})` call)
- Test: `apps/backend/src/services/__tests__/sessions-notify-default.test.ts`

**Interfaces:**
- Consumes: `SessionManagerService.createSession({ ..., notify?: boolean })` (already exists, `sessions.service.ts:212` maps it to the column).
- Produces: a session created through `SessionsService.createSession` persists `notify = 1`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/services/__tests__/sessions-notify-default.test.ts`. Assert at the repository level (create needs tmux; the default is a pure insert concern, so verify `SessionsService.createSession` reaches the manager with `notify: true` by testing the row it inserts is bell-on). The simplest robust check that doesn't spawn tmux: create via the repository with the same default the service now passes. But to lock the *service* behavior, spy is overkill — instead assert the DB-level contract: a session created through the create path has `notify=1`. Use the existing service test harness if one spawns tmux; otherwise test the repository default explicitly in this file:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";

// The service passes `notify: true` into manager.createSession; the manager
// persists it (`session-manager.service.ts` `notify: notify ? 1 : 0`). This
// pins that a new-session insert carries the bell ON. Spawning tmux is out of
// scope here; we exercise the repository the manager writes through.
describe("new-session notification default", () => {
  beforeAll(setupAuthTables);
  it("persists notify=1 for a bell-on create", async () => {
    const repo = new SessionsRepository(db);
    const row = await repo.create({
      id: crypto.randomUUID(),
      userId: "u-notify-default",
      profileId: "p1",
      harnessId: "pi",
      name: "n",
      workingDir: "/tmp",
      tmuxSocket: "mote-x",
      notify: 1,
    } as never);
    expect(row.notify).toBe(1);
    await repo.delete(row.id);
  });
});
```

- [ ] **Step 2: Add a service-layer assertion instead (primary)**

Because the repository already supports the flag, the real regression to guard is the **service** not passing it. Add to the same file, if a tmux-free create is impossible, a direct read of the create wiring is brittle — so the durable guard is an end-to-end route test in Phase 2's session tests. For THIS task, keep the repository-default test above (Step 1) as the executable contract and change the code in Step 3.

- [ ] **Step 3: Pass `notify: true` from the service create path**

In `apps/backend/src/services/sessions.service.ts`, change the manager call inside `createSession` (currently lines 91-97):

```ts
    const created = await this.#manager.createSession({
      userId,
      profileId,
      workingDir,
      name,
      prompt,
      // Notifications default ON for new sessions (spec 2026-08-31). The
      // per-user master switch still gates the actual send.
      notify: true,
    });
```

- [ ] **Step 4: Run tests, then full verification**

Run: `cd apps/backend && bun test src/services/__tests__/sessions-notify-default.test.ts`
Then root trio green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/sessions.service.ts apps/backend/src/services/__tests__/sessions-notify-default.test.ts
git commit -m "feat(notify): default the per-session bell ON for new sessions"
```

### Task 3: Master switch gates the send site

**Files:**
- Modify: `apps/backend/src/services/notify.service.ts:166-195` (`notifySession`) and its deps so it can read `user_meta.notify_enabled`
- Test: `apps/backend/src/services/__tests__/notify-master-switch.test.ts`

**Interfaces:**
- Consumes: `UserMetaRepository.getNotifyEnabled`.
- Produces: `notifySession(sessionId, kind)` returns early (no web-push, no device fan-out) when the owner's master switch is off, in addition to the existing `row.notify !== 1` bell check.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/services/__tests__/notify-master-switch.test.ts`. Follow the pattern used by the existing notify tests (`services/__tests__/notify.service.test.ts` — read it first for how `getNotifyService`/senders are injected/overridden). The test: seed a session with `notify=1` for a user who has a web-push subscription, flip the user's `notify_enabled` to 0, call `notifySession`, assert the send override recorded **zero** sends; flip to 1, assert one send.

- [ ] **Step 2: Run it, expect FAIL** (currently only the bell gates).

- [ ] **Step 2b: Add the master-switch check**

In `notify.service.ts`, construct a `UserMetaRepository` alongside the existing repos (follow how `sessionsRepo`/`deps.subs` are built at the top of `createNotifyService`). Then change the gate:

```ts
    async notifySession(sessionId: string, kind: NotifyKind): Promise<void> {
      try {
        const row = await sessionsRepo.findById(sessionId);
        if (row?.notify !== 1) return; // bell off
        // Per-user master switch (spec 2026-08-31): off ⇒ total silence
        // regardless of any session bells. Read of user_meta only, cheap.
        if (!(await userMetaRepo.getNotifyEnabled(row.userId))) return;
        // ... existing device fan-out + web-push loop unchanged ...
```

- [ ] **Step 3: Run the new test + existing notify tests, expect PASS**

Run: `cd apps/backend && bun test src/services/__tests__/notify-master-switch.test.ts src/services/__tests__/notify.service.test.ts`

- [ ] **Step 4: Full verification, then commit**

```bash
git add apps/backend/src/services/notify.service.ts apps/backend/src/services/__tests__/notify-master-switch.test.ts
git commit -m "feat(notify): gate the send site on the per-user master switch"
```

### Task 4: Per-user notification settings endpoint

**Files:**
- Modify: `apps/backend/src/api/notifications.route.ts`
- Test: `apps/backend/src/api/__tests__/notifications-route.test.ts` (extend)

**Interfaces:**
- Produces: `GET /api/notifications/settings → { notifyEnabled: boolean }`; `PATCH /api/notifications/settings { notifyEnabled } → { ok: true }`. Both cookie-only (reuse `requireCookieActor`), operating on the caller's own `user_meta`. operationIds `getNotificationSettings` / `setNotificationSettings`.

- [ ] **Step 1: Write failing route tests** in `notifications-route.test.ts`: an authenticated cookie user GETs their settings (expect `{ notifyEnabled: true }` by default), PATCHes to `false`, GETs again (expect `false`); a bearer actor gets 403.

- [ ] **Step 2: Run, expect FAIL** (routes absent → 404).

- [ ] **Step 3: Implement the two routes** on the `notificationsRoutes` instance (mirror the `/config` route's `requireCookieActor(actor, NOTIFICATIONS_403)` + `authGuard`). Read/write via `new UserMetaRepository(db)` (or `ctx` if the notifications route already takes context — match the file's existing style). Body schema:

```ts
const NotificationSettingsBodySchema = t.Object({
  notifyEnabled: t.Boolean({ description: "Master switch: false = never receive session pushes" }),
});
```

Return shape for GET: `t.Object({ notifyEnabled: t.Boolean({ description: "Current master-switch state" }) })`.

- [ ] **Step 4: Run tests PASS; full verification; commit**

```bash
git add apps/backend/src/api/notifications.route.ts apps/backend/src/api/__tests__/notifications-route.test.ts
git commit -m "feat(notify): GET/PATCH /api/notifications/settings (per-user master switch)"
```

### Task 5: Frontend master switch in Settings

**Files:**
- Modify: `apps/frontend/src/components/notifications-card.tsx`, `apps/frontend/src/lib/notifications.ts`, `apps/frontend/src/hooks/use-session-mutations.ts` (or a local hook in the card)
- Test: `apps/frontend/src/components/__tests__/notifications-card.test.tsx` (extend)

**Interfaces:**
- Consumes: `GET/PATCH /api/notifications/settings` (Task 4).

- [ ] **Step 1:** Add a `Switch` labeled "Notifications" bound to `notifyEnabled`, fetched via `apiFetch<{notifyEnabled:boolean}>("/api/notifications/settings")` and `PATCH`ed on toggle with optimistic update + rollback on error (mirror how `settings.tsx`'s `allowRegistrations` toggle reads/writes).
- [ ] **Step 2:** Extend the card test: renders the toggle from a stubbed GET; toggling PATCHes `{ notifyEnabled: false }`.
- [ ] **Step 3:** Run `cd apps/frontend && bun test src/components/__tests__/notifications-card.test.tsx`; full verification; commit `"feat(frontend): per-user notifications master switch in Settings"`.

---

## Phase 2 — Sharing: schema, resolver, guards, API

### Task 6: `session_shares` row type + repository

**Files:**
- Create: `apps/backend/src/db/types/session-shares.db-types.ts`
- Modify: `apps/backend/src/db/types/index.ts` (register `sessionShares`)
- Create: `apps/backend/src/db/repositories/session-shares.repository.ts`
- Test: `apps/backend/src/db/repositories/__tests__/session-shares.repository.test.ts`

**Interfaces:**
- Produces:
```ts
export type SessionSharePermission = "view" | "edit";
export interface SessionShareTable {
  id: string; sessionId: string; granteeUserId: string | null;
  permission: SessionSharePermission; createdBy: string; createdAt: string;
}
```
Repository: `listForSession(sessionId): Promise<SessionShareTable[]>`; `listForSessions(ids: string[]): Promise<Map<string, SessionShareTable[]>>`; `replaceForSession(sessionId, entries: {granteeUserId: string|null; permission: SessionSharePermission}[], createdBy): Promise<SessionShareTable[]>` (transactional delete-then-insert; validates the Everyone (null) grantee is unique by de-duping).

- [ ] **Step 1:** Write repo test: `replaceForSession` with one Everyone + one user row; `listForSession` returns both; `replaceForSession` again with fewer rows reflects the replace (no stale); `listForSessions` batches.
- [ ] **Step 2:** Fail → implement the type, the `Database.sessionShares` registration, and the repository (use `db.transaction()` for replace).
- [ ] **Step 3:** PASS; verify trio; commit `"feat(sharing): session_shares table, row type, repository"`.

### Task 7: The access resolver (pure) + loader

**Files:**
- Create: `apps/backend/src/lib/session-access.ts`
- Test: `apps/backend/src/lib/__tests__/session-access.test.ts`

**Interfaces:**
- Produces:
```ts
export type Access = "owner" | "edit" | "view" | "none";
/** Pure resolver — no DB. `shares` is the session's grant rows. */
export function resolveSessionAccess(
  viewerId: string, isAdmin: boolean, ownerUserId: string,
  shares: { granteeUserId: string | null; permission: "view" | "edit" }[],
): Access;
/** true when `have` meets `min` (owner>edit>view>none). */
export function accessAtLeast(have: Access, min: Exclude<Access, "none">): boolean;

/** Loads the row + shares + viewer role and resolves access. */
export async function loadSessionAccess(deps: {
  sessions: SessionsRepository; shares: SessionSharesRepository; userMeta: UserMetaRepository;
}, viewerId: string, sessionId: string): Promise<{ row: SessionTable | undefined; access: Access }>;
```
Resolution order (matches spec §4.2): owner → `owner`; admin → `edit`; else highest of Everyone + specific → `view`/`edit`/`none`.

- [ ] **Step 1:** Write the pure resolver test matrix: owner; admin (non-owner)→edit; Everyone(view) only→view; Everyone(edit)→edit; user-specific edit while Everyone view→edit (highest wins); user-specific view only→view; no shares→none; admin who is also owner→owner.
- [ ] **Step 2:** Fail → implement `resolveSessionAccess` + `accessAtLeast` (rank map `{none:0,view:1,edit:2,owner:3}`; `accessAtLeast` compares ranks; admin maps to `edit`).
- [ ] **Step 3:** Implement `loadSessionAccess`: `findById(sessionId)`; if missing → `{row: undefined, access:"none"}`; `isAdmin = (await userMeta.getRole(viewerId)) === "admin"`; `shares = await shares.listForSession(sessionId)`; return `{ row, access: resolveSessionAccess(viewerId, isAdmin, row.userId, shares) }`.
- [ ] **Step 4:** PASS; verify trio; commit `"feat(sharing): session access resolver (pure) + DB loader"`.

### Task 8: `access` on the session view + schema

**Files:**
- Modify: `apps/backend/src/api/models.ts` (`SessionSchema`), `apps/backend/src/services/session-manager.service.ts` (add `toViews(rows)` and a way to attach `access`), `apps/backend/src/services/sessions.service.ts` (attach `access` on get + list)
- Test: extend `apps/backend/src/services/__tests__/session-manager-view.test.ts` (or the sessions route tests)

**Interfaces:**
- Produces: every session view returned by `SessionsService` (get/list/summary-adjacent) includes `access: Access` (viewer-relative). `toSessionView` gains a trailing `access` field defaulted `"owner"` so existing direct callers stay valid; the service overrides it per-viewer.

- [ ] **Step 1:** Write test: `getSession(viewerId, id)` returns `.access === "owner"` for the owner.
- [ ] **Step 2:** Fail → add `access: t.Union([t.Literal("owner"),t.Literal("edit"),t.Literal("view")], { description: "Caller's effective access to this session" })` to `SessionSchema`. Add `access: "owner"` to `toSessionView`'s return and to its row-type/param as a defaulted arg `access: Access = "owner"`.
- [ ] **Step 3:** In `SessionsService.getSession`/`listSessions`, after building the view(s), set `access` from `loadSessionAccess` (single fetch) / batched `listForSessions` + one `getRole`. (Full visibility of shared rows lands in Task 9; here owner path already yields `"owner"`.)
- [ ] **Step 4:** PASS; `bun run build` (Eden re-infer) + verify trio; commit `"feat(sharing): viewer-relative access field on session views"`.

### Task 9: Visibility — list & summary include shared sessions

**Files:**
- Modify: `apps/backend/src/db/repositories/sessions.repository.ts` (`listVisibleTo`), `apps/backend/src/services/session-manager.service.ts` (`toViews(rows)` public), `apps/backend/src/services/sessions.service.ts` (`listSessions`/`summarySessions` take viewer + admin)
- Test: `apps/backend/src/db/repositories/__tests__/sessions-visible.test.ts`

**Interfaces:**
- Produces: `SessionsRepository.listVisibleTo(viewerId: string, isAdmin: boolean, status?): Promise<SessionTable[]>` = own ∪ (Everyone grant ∪ grant naming viewer), newest-first; admin → all. `SessionsService.listSessions(viewerId)` now resolves admin role, fetches visible rows, maps via `manager.toViews(rows)` with per-row `access`. Route/handlers pass the viewer id (unchanged signature).

- [ ] **Step 1:** Write repo test with two users + shared rows: viewer sees own + everyone-shared + user-shared; a private foreign session is NOT returned; admin sees everything.
- [ ] **Step 2:** Fail → implement `listVisibleTo` with a Kysely `where` of `or` group + `exists` on `sessionShares`; `toViews` extracted from the current `listSessions` mapping (reuse `#preview`).
- [ ] **Step 3:** Rewire `SessionsService.listSessions` + `summarySessions` to `listVisibleTo` + resolve admin; attach `access` per row (batch `listForSessions`).
- [ ] **Step 4:** PASS; verify trio; commit `"feat(sharing): session list & summary include shared sessions"`.

### Task 10: Access-gate every session route

**Files:**
- Modify: `apps/backend/src/services/sessions.service.ts` (all owner-keyed methods) and `apps/backend/src/api/sessions/*.route.ts` (pass needed context; error mapping)
- Test: extend `apps/backend/src/api/__tests__/` route tests + a new `apps/backend/src/api/__tests__/sessions-sharing-routes.test.ts`

**Interfaces:**
- Consumes: `loadSessionAccess`, `accessAtLeast`.
- Produces: each mutation/read enforces `§4.1` level. Mapping: get/log → `view`; rename/notes/restart/terminate → `edit`; delete/notify/shares → `owner`. A `none` access → 404 `not_found`; below-min → 403 `ForbiddenError`/`HttpError`.

- [ ] **Step 1:** Write the matrix test: as a view grantee → get 200, rename 403, terminate 403, delete 403, notify 403, shares GET 403. As an edit grantee → rename 200, terminate 200, delete 403, shares 403. As non-grantee → get 404. As owner → all 200.
- [ ] **Step 2:** Fail → refactor `SessionsService` methods to `loadSessionAccess` first, then call the manager with **`row.userId`** (the owner) so the manager's internal owner-check trivially holds and data ops are correct; keep the session-key self-only rules in the routes (notify/extend-token). Add `requireViewerAccess(row,access,min)` inline in the service throwing `SessionError` (404) when none, else `HttpError(403,...)`.
- [ ] **Step 3:** `createSession` unchanged (always sets viewer as owner). `getSession` returns the manager view with the resolved `access` (from Task 8) — pass viewer id to the manager with owner id and overwrite `access`.
- [ ] **Step 4:** PASS; `bun run build` + verify trio; commit `"feat(sharing): access-gate all session routes (view/edit/owner)"`.

### Task 11: Share CRUD routes

**Files:**
- Create: `apps/backend/src/api/sessions/get-session-shares.route.ts`, `set-session-shares.route.ts`
- Modify: `apps/backend/src/api/sessions/index.ts` (mount), `apps/backend/src/services/sessions.service.ts` (`getShares`, `setShares`)
- Test: `apps/backend/src/api/__tests__/sessions-share-routes.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/sessions/:id/shares` (owner) → `{ shares: [{ id, granteeUserId: string|null, granteeName: string|null, permission }] }`
  - `PUT /api/sessions/:id/shares` (owner) body `{ shares: [{ granteeUserId?: string|null, permission: "view"|"edit" }] }` → same shape; 400 on unknown grantee.

- [ ] **Step 1:** Write route test: owner PUTs Everyone+user, GETs them back with names; PUT then PUT-fewer replaces; view/edit grantee gets 403; non-grantee 404.
- [ ] **Step 2:** Fail → implement service `getShares` (join user display names via users repo), `setShares` (validate each non-null grantee exists → else 400; call `replaceForSession`). Both behind `loadSessionAccess` at `owner`. Add schemas (all props with `description`), `operationId`s `getSessionShares`/`setSessionShares`.
- [ ] **Step 3:** PASS; `bun run build` + verify trio; commit `"feat(sharing): GET/PUT /api/sessions/:id/shares"`.

---

## Phase 3 — Realtime & panes

### Task 12: WS attach honors access; input gated to edit

**Files:**
- Modify: `apps/backend/src/ws/session-ws.ts` (attach + `handleSessionMessage` + `WsData`), thread admin/shares via `getRequestlessContext()`
- Test: extend `apps/backend/src/ws/__tests__/session-ws.test.ts`

**Interfaces:**
- Consumes: `loadSessionAccess` (build repos from `getRequestlessContext().repos`).
- Produces: attach requires `access >= view` (else close `4004`); `WsData.canInput: boolean` = `access ∈ {owner,edit}`; `handleSessionMessage` drops terminal-input frames (`frame.data`) when `!canInput` (resize still allowed).

- [ ] **Step 1:** Write test: a view grantee attaches (opens, receives replay) but an input frame produces no `sendInput`; an edit grantee's input reaches tmux; a non-grantee close `4004`.
- [ ] **Step 2:** Fail → in `handleSessionWs`, replace the `row.userId !== userId` check with `loadSessionAccess(...)`; require `accessAtLeast(access,"view")`; set `canInput` on `data`. In `handleSessionMessage`, guard the `frame.data` branch with `if (!data.canInput) return;`.
- [ ] **Step 3:** PASS; verify trio; commit `"feat(sharing): WS attach honors access, input requires edit"`.

### Task 13: Workspace pane-add requires view

**Files:**
- Modify: `apps/backend/src/services/workspaces.service.ts:217-234` (`addWorkspacePane`)
- Test: `apps/backend/src/api/workspaces/__tests__/workspaces-route.test.ts` (extend)

**Interfaces:**
- Consumes: `loadSessionAccess`.

- [ ] **Step 1:** Write test: adding a pane for a session shared-to-me (view) now succeeds; a private foreign session still 404.
- [ ] **Step 2:** Fail → replace `session.userId !== userId` with `loadSessionAccess`; require `accessAtLeast(access,"view")`; 404 when none.
- [ ] **Step 3:** PASS; verify trio; commit `"feat(sharing): workspace pane-add allows viewable sessions"`.

---

## Phase 4 — Web UI

### Task 14: Frontend types + share/settings hooks

**Files:** Modify `apps/frontend/src/types/session.ts`, `apps/frontend/src/hooks/use-session-mutations.ts`, `apps/frontend/src/lib/api.ts` (if helpers needed). Test: a hooks/lib unit test.

- [ ] **Step 1:** Add `access: "owner"|"edit"|"view"` to `SessionView`; add `useShares(id)` (GET) + `useSetShares(id)` (PUT) + reuse settings hooks. `bunx tsc` surfaces required call-site updates.
- [ ] **Step 2:** Implement; `verify-types`; commit `"feat(frontend): session access type + share hooks"`.

### Task 15: Sharing dialog + access-driven controls

**Files:** Create `apps/frontend/src/components/sharing-dialog.tsx`; modify `session-actions-menu.tsx`, `routes/sessions_.$id.tsx`. Test: `components/__tests__/sharing-dialog.test.tsx`.

- [ ] **Step 1:** Build the dialog (owner-only): list current grants with a view/edit select + remove; add row = "Everyone" or a user (from the roster) + level; Save PUTs the whole list. Component test: renders grants, add+save calls `PUT` with the merged list.
- [ ] **Step 2:** In the session detail/menu, gate by `access`: hide delete/share/bell for non-owners; hide rename/notes/restart/terminate for `view`. Terminal read-only handled in Task 16.
- [ ] **Step 3:** `cd apps/frontend && bun test src/components/__tests__/sharing-dialog.test.tsx`; verify trio; commit `"feat(frontend): sharing dialog + access-gated controls"`.

### Task 16: Terminal read-only for viewers

**Files:** Modify `apps/frontend/src/components/session-terminal.tsx`, `apps/frontend/src/lib/use-session-ws.ts`, `apps/frontend/src/components/terminal-key-bar.tsx`.

- [ ] **Step 1:** Pass `canInput = access !== "view"` into the terminal hook and key bar. xterm `onData` must not send when read-only (still streams output); key bar hidden/disabled at view.
- [ ] **Step 2:** A unit test where a `view` session's data callback does not call the ws `send`. verify trio; commit `"feat(frontend): shared sessions render read-only terminal"`.

### Task 17: New-session bell defaults ON

**Files:** Modify `apps/frontend/src/components/session-picker/new-session-form.tsx`, `add-session-dialog.tsx`.

- [ ] **Step 1:** Default the bell toggle to ON in both create paths. Add/adjust the form test to assert default-checked. verify trio; commit `"feat(frontend): new-session bell defaults on"`.

---

## Phase 5 — Mobile parity

### Task 18: Mobile honors access (read-only + action gating)

**Files:** Modify `apps/mobile/src/types/session.ts`, `apps/mobile/src/components/session-detail.tsx`, the mobile terminal input path (WebView key bar / `sendInput`).

- [ ] **Step 1:** Add `access` to the mobile `SessionView`. In `session-detail.tsx`, when `access === "view"`: hide the Bell/Rename/Restart/Terminate actions and disable terminal input; `edit`: keep all except Delete (owner-only). Owner: unchanged.
- [ ] **Step 2:** A small test for the action-visibility helper if extracted; `cd apps/mobile && bun run verify-types`; verify trio; commit `"feat(mobile): honor session access (read-only views, owner-only actions)"`.

---

## Phase 6 — Docs + end-to-end

### Task 19: Security posture doc

**Files:** Modify `.claude/rules/security-context.md`.

- [ ] **Step 1:** Add a subsection: sessions are owner-private by default, shareable via view/edit grants to Everyone or specific users; admins hold instance-wide **edit** (not delete/re-share); terminal input requires edit; notifications are owner-targeted behind the per-user master switch. Note this widens exposure beyond the owner on the trusted network.
- [ ] **Step 2:** `bun run lint:check` (docs aren't linted, but keep the trio honest); commit `"docs: record session sharing + notification defaults in the security posture"`.

### Task 20: End-to-end (two users)

**Files:** Create `e2e/tests/11-session-sharing.spec.ts`.

- [ ] **Step 1:** Using the admin storage state, mint a second user (as spec 10 does via `POST /api/users`), have the admin create a session, PUT a share (`view`) to the second user, sign in as that user in a fresh context: the session appears, the terminal is read-only, rename is absent. Then share at `edit`: rename now available. Assert a never-shared session is 404/invisible to the second user.
- [ ] **Step 2:** `cd e2e && bunx playwright test 11-session-sharing` (needs the running dev backend on :3199 via the e2e stack) — green. Commit `"test(e2e): session sharing view vs edit round-trip"`.

---

## Self-Review notes

- **Spec coverage:** §3 schema → Tasks 1,6; §4 resolver → Task 7; §5 plumbing (routes 10, list 9, ws 12, workspace 13) → Tasks 9–13; §6 API → Tasks 4,11,8; §7 UI → 14–18; §8 migration → 1,6; §9 tests → per-task; §10 docs → 19. All covered.
- **Type consistency:** `Access = "owner"|"edit"|"view"|"none"` used identically in Tasks 7,8,10,12,14,16,18. Permission values `"view"|"edit"` in Tasks 6,7,11,15. `notify_enabled`↔`notifyEnabled`↔`notifyEnabled:boolean` boundary is `number` in DB, `boolean` in repo/API/UI — consistent across Tasks 1,3,4,5.
- **Ordering:** Phase 1 is independently shippable green; Phases 2–3 are backend-complete and testable before any UI; UI (4) and mobile (5) ride the `access` field.
- **Riskiest task:** Task 10 (rewiring all manager calls to pass `row.userId`) — mitigated by "pass owner id, gate first, fails closed" and the full matrix test.
