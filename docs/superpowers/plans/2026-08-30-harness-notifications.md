# Harness Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OS-level push notifications (desktop + mobile) when a session finishes a turn, needs approval, or exits — opt-in per session via a ⋯-menu bell, default silent — plus a "Waiting for you" state that surfaces in the session lists.

**Architecture:** Web Push (service worker + VAPID keys generated once into the data dir). Events come from two tiers: Claude Code's native `Stop`/`Notification` hooks (injected into the `--settings` mote already passes, curling the backend with the pane's own bearer) for precise signals, and a 3 s quiet-output watcher for every other harness. The policy is one `sessions.notify` column checked at send time; the same signals maintain `sessions.waiting_since` for the UI chip.

**Tech Stack:** Elysia + Kysely (bun:sqlite), `web-push`, React 19 + TanStack Query, a hand-written service worker under `public/`.

**Spec:** `docs/superpowers/specs/2026-08-30-harness-notifications-design.md`

## Global Constraints

- Verification trio after every task: `bun run verify-types && bun run lint:check && bun run test` (repo root). Never commit on red.
- All new deps pinned exactly; after `bun add` run `bunx syncpack fix` + `bun install` if prefixes appear.
- New migrations live in `apps/backend/src/db/migrations/` **and** are registered in the static provider map in `apps/backend/src/db/migrate.ts` (file name == map key).
- Every `t` schema property carries a `description`; interface properties carry JSDoc (`.claude/rules/code-style.md`).
- Tests only via `bun test`; backend suites share the per-process temp DB via `src/test-preload.ts` — never assume it starts empty; manual migration chains in test files must be extended with any new migration.
- Machine credentials are rejected on browser-only endpoints (cookie actor), harness self-reporting endpoints accept only the session's own bearer (`principal === sess:<id>`).
- No dynamic imports anywhere.
- Frontend `SessionView` mirrors backend `toSessionView` exactly (hand-maintained mirror in `apps/frontend/src/types/session.ts`).
- Commits: conventional style as used on `main` (`feat(...)`, `fix(...)`, `test(...)`), scope like `(sessions)`, `(frontend)`, `(harnesses)`.

---

### Task 1: Migration 0014 — notify columns + subscriptions table

**Files:**
- Create: `apps/backend/src/db/migrations/0014-session-notifications.ts`
- Modify: `apps/backend/src/db/migrate.ts` (import + map entry, after the `0013-session-harness-id` lines)
- Modify: `apps/backend/src/db/types/sessions.db-types.ts` (SessionTable + NewSession)
- Create: `apps/backend/src/db/types/notification-subscriptions.db-types.ts`
- Modify: `apps/backend/src/db/types/index.ts` (Database interface)
- Test: `apps/backend/src/db/migrations/__tests__/0014-session-notifications.test.ts`
- Modify (migration chains): `apps/backend/src/services/__tests__/session-manager.service.test.ts`, `apps/backend/src/services/__tests__/session-manager-mcp.test.ts`, `apps/backend/src/api/__tests__/live-restart-notes.test.ts`, `apps/backend/src/db/repositories/__tests__/repositories.test.ts`, `apps/backend/src/db/repositories/__tests__/workspaces-repository.test.ts` — each already imports `sessionHarnessIdMigration`; add the 0014 import + `await sessionNotificationsMigration.up(db);` line the same way (python/loop edit as in 0013).

**Interfaces:**
- Consumes: nothing.
- Produces: columns `sessions.notify` (integer, notNull, default 0), `sessions.waiting_since` (text, nullable); table `notifications_subscriptions(id, user_id, endpoint UNIQUE, p256dh, auth, created_at)`; TS types `SessionTable.notify: number`, `SessionTable.waitingSince: string | null`, `NotificationSubscriptionTable`.

- [ ] **Step 1: Write the failing migration test**

Create `apps/backend/src/db/migrations/__tests__/0014-session-notifications.test.ts` (follows the 0013 test's conventions — in-memory Kysely + CamelCasePlugin):

```ts
import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as notificationsMigration from "@/db/migrations/0014-session-notifications.js";
import { openSqliteDatabase } from "@/db/open-database.js";

async function migratedDb() {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  return db;
}

describe("migration 0014-session-notifications", () => {
  it("adds notify (default 0) and waiting_since (null) to sessions; old rows unaffected", async () => {
    const db = await migratedDb();
    await db
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p1",
        harnessId: "claude-code",
        name: "Old",
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();
    await notificationsMigration.up(db);
    const row = await db.selectFrom("sessions").select(["notify", "waitingSince"]).where("id", "=", "s1").executeTakeFirst();
    expect(row).toEqual({ notify: 0, waitingSince: null });
    await notificationsMigration.down(db);
    const cols = await db.selectFrom("pragma_table_info('sessions') as t").select("t.name").execute();
    expect(cols.map((c) => c.name)).not.toContain("notify");
    expect(cols.map((c) => c.name)).not.toContain("waiting_since");
    await db.destroy();
  });

  it("creates notifications_subscriptions with a unique endpoint", async () => {
    const db = await migratedDb();
    await notificationsMigration.up(db);
    await db
      .insertInto("notifications_subscriptions")
      .values({ id: "n1", userId: "u1", endpoint: "https://push/a", p256dh: "k", auth: "a", createdAt: "t" })
      .execute();
    // The same endpoint (a re-authorized browser) may not exist twice.
    await expect(
      db
        .insertInto("notifications_subscriptions")
        .values({ id: "n2", userId: "u2", endpoint: "https://push/a", p256dh: "k", auth: "a", createdAt: "t" })
        .execute(),
    ).rejects.toThrow(/UNIQUE/i);
    await notificationsMigration.down(db);
    await expect(db.selectFrom("notifications_subscriptions").selectAll().execute()).rejects.toThrow(
      /no such table/i,
    );
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run it, confirm failure**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0014-session-notifications.test.ts`
Expected: FAIL — cannot resolve `0014-session-notifications.js`.

- [ ] **Step 3: Write the migration**

Create `apps/backend/src/db/migrations/0014-session-notifications.ts`:

```ts
import type { Kysely } from "kysely";

/**
 * Session notifications (spec 2026-08-30-harness-notifications):
 *
 * - `sessions.notify`: 1 = push the owner when this session finishes a turn,
 *   needs approval, or exits. Default 0 — silent unless the operator rings
 *   the bell — including rows created before this migration.
 * - `sessions.waiting_since`: ISO timestamp of the attention event that put
 *   the session in "waiting for you" state (null = not waiting). Set by the
 *   harness hook / idle watcher, cleared when output resumes or the pane dies.
 * - `notifications_subscriptions`: one row per browser push subscription,
 *   owned by a user. `endpoint` is unique: a re-authorized browser replaces
 *   its own row (the endpoint string is the browser's identity here).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sessions").addColumn("notify", "integer", (c) => c.notNull().defaultTo(0)).execute();
  await db.schema.alterTable("sessions").addColumn("waiting_since", "text").execute();
  await db.schema
    .createTable("notifications_subscriptions")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("endpoint", "text", (c) => c.notNull())
    .addColumn("p256dh", "text", (c) => c.notNull())
    .addColumn("auth", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_notifications_subscriptions_endpoint").unique().on("notifications_subscriptions").column("endpoint").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("notifications_subscriptions").execute();
  await db.schema.alterTable("sessions").dropColumn("waiting_since").execute();
  await db.schema.alterTable("sessions").dropColumn("notify").execute();
}
```

Register in `apps/backend/src/db/migrate.ts`:

```ts
import * as sessionNotificationsMigration from "@/db/migrations/0014-session-notifications.js";
// …in the getMigrations() map, after "0013-session-harness-id":
"0014-session-notifications": sessionNotificationsMigration,
```

- [ ] **Step 4: Types**

In `apps/backend/src/db/types/sessions.db-types.ts` — add to `SessionTable` (after `nameLocked`):

```ts
  /** 1 = push the owner on attention events (done / approval / exit) */
  notify: number;
  /** ISO ts of the "waiting for you" event (null = not waiting). See migration 0014. */
  waitingSince: string | null;
```

Add `"notify" | "waitingSince"` to the `NewSession` `Omit<…>` union and `notify?: number; waitingSince?: string | null;` to the optional part.

Create `apps/backend/src/db/types/notification-subscriptions.db-types.ts`:

```ts
/**
 * Database table schema for one browser's Web Push subscription.
 * Owned by the user who enabled notifications in that browser.
 */
export interface NotificationSubscriptionTable {
  /** Unique id (uuid) */
  id: string;
  /** Owner of this device subscription */
  userId: string;
  /** Push endpoint URL from pushManager.subscribe() (unique — a re-authorized browser replaces its row) */
  endpoint: string;
  /** P-256 ECDH public key (base64url) */
  p256dh: string;
  /** Auth secret (base64url) */
  auth: string;
  /** ISO 8601 timestamp when stored */
  createdAt: string;
}

/** Insert shape: createdAt is written by the repository (no DB default). */
export type NewNotificationSubscription = Omit<NotificationSubscriptionTable, "createdAt"> & {
  createdAt?: string;
};
```

In `apps/backend/src/db/types/index.ts`: import `NotificationSubscriptionTable` and add `notificationsSubscriptions: NotificationSubscriptionTable;` to `Database`.

- [ ] **Step 5: Extend the manual migration chains in the 5 test files**

In each of the five files listed in **Files:**, add next to the existing `sessionHarnessIdMigration` import/`up` call:

```ts
import * as sessionNotificationsMigration from "@/db/migrations/0014-session-notifications.js";
// after await sessionHarnessIdMigration.up(db);
await sessionNotificationsMigration.up(db); // sessions.notify / waiting_since + subscriptions
```

(The same two-line python-patch pattern used when 0013 landed — insert after the lines containing `sessionHarnessIdMigration`.)

- [ ] **Step 6: Run tests, confirm pass**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0014-session-notifications.test.ts src/services/__tests__/session-manager.service.test.ts`
Expected: PASS (the service suite must stay green proving inserts survive the new NOT NULL column, which the default covers).

- [ ] **Step 7: Full trio + commit**

```bash
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/db packages/harnesses 2>/dev/null; git add -A apps/backend
git commit -m "feat(sessions): notify column, waiting_since, subscriptions table (migration 0014)"
```

---

### Task 2: Claude Code attention hooks (harnesses package)

**Files:**
- Modify: `packages/harnesses/src/types.ts` (HarnessPlugin capability flag)
- Modify: `packages/harnesses/src/claude-code.ts` (hooks constant, `supportsAttentionHooks`, settings merge in `buildCommand`)
- Test: `packages/harnesses/src/__tests__/claude-code.test.ts` (update existing argv expectations + new cases)

**Interfaces:**
- Consumes: the pane env baked by the backend (`MOTE_BASE_URL`, `MOTE_SESSION_ID`, `MOTE_API_KEY` — already exported by `sessionMcpEnv`).
- Produces:
  - `HarnessPlugin.supportsAttentionHooks?: boolean` (true on `ClaudeCodePlugin`).
  - Every claude launch's `--settings` JSON now contains `hooks.Stop` (kind `turn_complete`) and `hooks.Notification` (kind `needs_attention`) whose command POSTs to `/api/sessions/$MOTE_SESSION_ID/attention` using `bun -e 'fetch(...)'` (bun is at `/usr/local/bin/bun` in the container and on host PATH; no curl exists in the image).
  - Exported for reuse/tests: `export const ATTENTION_HOOKS: Record<string, unknown>` from `claude-code.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/harnesses/src/__tests__/claude-code.test.ts`:

```ts
describe("ClaudeCodePlugin attention hooks", () => {
  it("declares native attention-hook support", () => {
    expect(plugin.supportsAttentionHooks).toBe(true);
  });

  it("always emits --settings carrying Stop and Notification hooks", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: emptyProfile(),
      sessionName: "",
    });
    const idx = cmd.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    const settings = JSON.parse(cmd[idx + 1]) as {
      hooks: { Stop?: unknown[]; Notification?: unknown[] };
    };
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.Notification).toBeDefined();
    const stopCmd = (settings.hooks.Stop as [{ hooks: [{ command: string }] }])[0].hooks[0].command;
    expect(stopCmd).toContain("bun -e");
    expect(stopCmd).toContain("/attention");
    expect(stopCmd).toContain("turn_complete");
    const notifCmd = (settings.hooks.Notification as [{ hooks: [{ command: string }] }])[0].hooks[0].command;
    expect(notifCmd).toContain("needs_attention");
  });

  it("profile settings survive the merge (hooks added alongside, not replacing)", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: { name: "p", env: {}, flags: [], settings: { model: "sonnet" }, configIsolation: false },
      sessionName: "",
    });
    const settings = JSON.parse(cmd[cmd.indexOf("--settings") + 1]) as Record<string, unknown>;
    expect(settings.model).toBe("sonnet");
    expect(settings.hooks).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, confirm failures** (`bun test src/__tests__/claude-code.test.ts` in `packages/harnesses`)

- [ ] **Step 3: Implement**

`packages/harnesses/src/types.ts` — inside `HarnessPlugin`, after the `resume?: HarnessResume;` entry:

```ts
  /**
   * True when `buildCommand` wires this harness's native "needs attention"
   * reporting into the launch (Claude Code: Stop/Notification hooks).
   * The backend's quiet-output idle watcher skips these harnesses.
   */
  supportsAttentionHooks?: boolean;
```

`packages/harnesses/src/claude-code.ts` — module scope, above the class:

```ts
/**
 * Fire-and-forget attention reporting. Each hook runs `bun -e` (bun is on the
 * pane PATH — the image ships it, and no curl exists there) and POSTs the
 * session's own bearer to the attention endpoint; the server gates delivery
 * on the session's bell and derives the "waiting for you" state. The env
 * vars are baked into the pane by the backend (`sessionMcpEnv`), and every
 * failure path is swallowed: a missing hook event costs one notification,
 * never a broken session turn. MOTE_BASE_URL must be reachable from inside
 * the pane's network — in the container that means the published port, which
 * compose already passes via APP_BASE_URL.
 */
const attentionPing = (kind: string): string =>
  `bun -e '` +
  `fetch(process.env.MOTE_BASE_URL+"/api/sessions/"+process.env.MOTE_SESSION_ID+"/attention",` +
  `{method:"POST",headers:{authorization:"Bearer "+process.env.MOTE_API_KEY,"content-type":"application/json"},` +
  `body:JSON.stringify({kind:${JSON.stringify(kind)}}),signal:AbortSignal.timeout(5000)})` +
  `.catch(()=>{}).finally(()=>process.exit(0))'`;

/** The `--settings` hooks object injected into every Claude Code launch. */
export const ATTENTION_HOOKS = {
  Stop: [{ hooks: [{ type: "command", command: attentionPing("turn_complete") }] }],
  Notification: [{ hooks: [{ type: "command", command: attentionPing("needs_attention") }] }],
} as const;
```

In the class: `readonly supportsAttentionHooks = true;`

Replace the settings block in `buildCommand`:

```ts
    // Settings JSON is passed via --settings so profiles never touch the
    // user's real ~/.claude files. The attention hooks ride along on EVERY
    // launch (mote's signal wins if a profile set its own `hooks` key —
    // documented limitation, the alternative is no notifications).
    const settings = { ...(profile.settings ?? {}), hooks: ATTENTION_HOOKS };
    args.push("--settings", JSON.stringify(settings));
```

- [ ] **Step 4: Update the existing argv tests** whose expectations assumed no `--settings`: `bare launch with no profile extra` → expect `["/usr/bin/claude", "--settings", <json>]` (assert `cmd[0]` and that JSON.parse of `cmd[2]` has `hooks`); in `passes settings JSON, name, flags` and any other test locating `--settings` by `indexOf`, nothing changes semantically — they keep passing because the flag still exists. Fix only the two expectations that assert the exact bare-argv array or `--mcp-config` slice indexes if they shifted (`slice(0,3)` on the MCP splice test now includes `--settings` at index 1? — order is binary → mcp args → settings → session-id pin → name, so MCP splice test passes unchanged; the bare-launch test and the `omits --mcp-config` test need `not.toContain` adjustments only where they assert full equality).

- [ ] **Step 5: `bun test` in the package; then full trio from repo root; rebuild the package dist for backend consumers: `cd packages/harnesses && bun run build`**

- [ ] **Step 6: Commit**

```bash
git add packages/harnesses && git commit -m "feat(harnesses): claude attention hooks report turn-complete/needs-approval"
```

---

### Task 3: NotificationsRepository + notify.service (the delivery bus)

**Files:**
- Create: `apps/backend/src/db/repositories/notifications.repository.ts`
- Create: `apps/backend/src/services/notify.service.ts`
- Modify: `apps/backend/package.json` (add pinned `web-push@2.2.8`, dev `@types/web-push@3.4.4`), `bun install`
- Test: `apps/backend/src/services/__tests__/notify.service.test.ts`

**Interfaces:**
- Consumes: `NotificationSubscriptionTable` (Task 1), `SessionsRepository.findById` (existing), `SESSION_DATA_DIR` (constants.ts).
- Produces (used by Tasks 4/5/6/7):
  - `NotificationsRepository`: `upsertForUser(userId, endpoint, p256dh, auth): Promise<void>`, `deleteForUser(userId, endpoint): Promise<void>`, `listByUser(userId): Promise<NotificationSubscriptionTable[]>`, `deleteByEndpoint(endpoint): Promise<void>`.
  - `notify.service`: `type NotifyKind = "turn_complete" | "needs_attention" | "exited" | "crashed"`; `buildNotificationPayload(row: {id, name}, kind): {title, body, url, tag}` (pure); `notifySession(sessionId, kind): Promise<void>` (bell gate → owner fan-out → prune dead endpoints); `vapidPublicKey(): Promise<string>`; `__setSenderForTests(sender | null)` and `__setVapidDirForTests(dir | null)` (test seams per the singleton rule).

- [ ] **Step 1: Install deps (pinned)**

```bash
cd apps/backend && bun add web-push@2.2.8 && bun add -d @types/web-push@3.4.4
```

- [ ] **Step 2: Write the failing tests**

`apps/backend/src/services/__tests__/notify.service.test.ts` — the send layer is injected; migrations run manually against a private in-memory Kysely; the service takes a `db`-bound repositories object as an optional constructor-style dep (mirror how `SessionManagerService` takes `audit`/`tokens` defaults):

```ts
import { beforeEach, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as notificationsMigration from "@/db/migrations/0014-session-notifications.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import { buildNotificationPayload, createNotifyService, type PushSender } from "@/services/notify.service.js";
import type { Database } from "@/db/types/index.js";

async function freshDb() {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db as Kysely<any>);
  await notificationsMigration.up(db as Kysely<any>);
  return db;
}

function sender(record: {to: string[]}): PushSender {
  return async (sub) => {
    record.to.push(sub.endpoint);
    return { statusCode: 201 };
  };
}

describe("buildNotificationPayload", () => {
  it("maps each kind to its copy and always targets the session url with a session tag", () => {
    const p = buildNotificationPayload({ id: "sid", name: "resume-verify" }, "turn_complete");
    expect(p).toEqual({
      title: "resume-verify",
      body: "Done — waiting for you",
      url: "/sessions/sid",
      tag: "sid",
    });
    expect(buildNotificationPayload({ id: "s", name: "x" }, "needs_attention").body).toBe("Needs your approval");
    expect(buildNotificationPayload({ id: "s", name: "x" }, "exited").body).toBe("Session exited");
    expect(buildNotificationPayload({ id: "s", name: "x" }, "crashed").body).toBe("Crashed — auto-restarting");
  });
});

describe("notifySession", () => {
  beforeEach(() => {});

  it("stays silent unless the session's bell is on", async () => {
    const db = await freshDb();
    await db
      .insertInto("sessions")
      .values({ id: "s1", userId: "u1", profileId: "p", harnessId: "h", name: "n", workingDir: "/tmp", tmuxSocket: null })
      .execute();
    const repo = new NotificationsRepository(db);
    await repo.upsertForUser("u1", "https://push/a", "k", "a");
    const hits: { to: string[] } = { to: [] };
    const svc = createNotifyService({
      sessions: db,
      subs: repo,
      sender: sender(hits),
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
    });
    await svc.notifySession("s1", "turn_complete");
    expect(hits.to).toEqual([]); // bell off → nothing sent
    await db.updateTable("sessions").set({ notify: 1 }).where("id", "=", "s1").execute();
    await svc.notifySession("s1", "turn_complete");
    expect(hits.to).toEqual(["https://push/a"]);
    await db.destroy();
  });

  it("prunes subscriptions whose endpoint 404/410s, keeps others", async () => {
    const db = await freshDb();
    await db
      .insertInto("sessions")
      .values({ id: "s1", userId: "u1", profileId: "p", harnessId: "h", name: "n", workingDir: "/tmp", tmuxSocket: null, notify: 1 })
      .execute();
    const repo = new NotificationsRepository(db);
    await repo.upsertForUser("u1", "https://push/dead", "k", "a");
    await repo.upsertForUser("u1", "https://push/alive", "k", "a");
    const svc = createNotifyService({
      sessions: db,
      subs: repo,
      sender: async (sub) => {
        if (sub.endpoint.endsWith("dead")) throw Object.assign(new Error("gone"), { statusCode: 410 });
        return { statusCode: 201 };
      },
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
    });
    await svc.notifySession("s1", "exited");
    expect((await repo.listByUser("u1")).map((s) => s.endpoint)).toEqual(["https://push/alive"]);
    await db.destroy();
  });

  it("never notifies another user's subscriptions", async () => {
    const db = await freshDb();
    await db
      .insertInto("sessions")
      .values({ id: "s1", userId: "u1", profileId: "p", harnessId: "h", name: "n", workingDir: "/tmp", tmuxSocket: null, notify: 1 })
      .execute();
    const repo = new NotificationsRepository(db);
    await repo.upsertForUser("u2", "https://push/other", "k", "a");
    const hits: { to: string[] } = { to: [] };
    const svc = createNotifyService({ sessions: db, subs: repo, sender: sender(hits), vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" } });
    await svc.notifySession("s1", "turn_complete");
    expect(hits.to).toEqual([]);
    await db.destroy();
  });
});
```

- [ ] **Step 3: Run, confirm fail (module missing).**

- [ ] **Step 4: Implement**

`apps/backend/src/db/repositories/notifications.repository.ts`:

```ts
import type { Kysely } from "kysely";
import type { NotificationSubscriptionTable } from "@/db/types/notification-subscriptions.db-types.js";
import type { Database } from "@/db/types/index.js";

/**
 * One row per browser push subscription. `endpoint` is globally unique — a
 * re-authorized browser (even under another user) replaces the row, because
 * the endpoint IS the browser's mailbox: only its current holder can be
 * written to it.
 */
export class NotificationsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async upsertForUser(userId: string, endpoint: string, p256dh: string, auth: string): Promise<void> {
    // bun:sqlite cannot upsert after INSERT…SELECT, but here a plain
    // delete-then-insert beats any ON CONFLICT dance: the row's OWNER may
    // change (shared browser), so "conflict" is a legitimate move, not a no-op.
    await this.db.deleteFrom("notificationsSubscriptions").where("endpoint", "=", endpoint).execute();
    await this.db
      .insertInto("notificationsSubscriptions")
      .values({
        id: crypto.randomUUID(),
        userId,
        endpoint,
        p256dh,
        auth,
        createdAt: new Date().toISOString(),
      })
      .execute();
  }

  async deleteForUser(userId: string, endpoint: string): Promise<void> {
    await this.db
      .deleteFrom("notificationsSubscriptions")
      .where("userId", "=", userId)
      .where("endpoint", "=", endpoint)
      .execute();
  }

  async listByUser(userId: string): Promise<NotificationSubscriptionTable[]> {
    return this.db.selectFrom("notificationsSubscriptions").selectAll().where("userId", "=", userId).execute();
  }

  async deleteByEndpoint(endpoint: string): Promise<void> {
    await this.db.deleteFrom("notificationsSubscriptions").where("endpoint", "=", endpoint).execute();
  }
}
```

`apps/backend/src/services/notify.service.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import webpush from "web-push";
import { SESSION_DATA_DIR } from "@/constants.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import type { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import type { Database } from "@/db/types/index.js";
import { logger } from "@/utils/logger.js";

/** What happened to a session. The wire contract with the hooks and the watcher. */
export type NotifyKind = "turn_complete" | "needs_attention" | "exited" | "crashed";

const BODY: Record<NotifyKind, string> = {
  turn_complete: "Done — waiting for you",
  needs_attention: "Needs your approval",
  exited: "Session exited",
  crashed: "Crashed — auto-restarting",
};

/**
 * The push payload the service worker turns into an OS notification. `tag`
 * is the session id so a newer event replaces that session's older
 * notification instead of stacking. The URL is relative (same-origin), the
 * SW resolves it against its own scope.
 */
export function buildNotificationPayload(row: { id: string; name: string }, kind: NotifyKind) {
  return { title: row.name, body: BODY[kind], url: `/sessions/${row.id}`, tag: row.id };
}

/** Minimal seam over web-push so tests inject a fake. */
export type PushSender = (
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
) => Promise<{ statusCode: number }>;

export interface NotifyServiceDeps {
  sessions: Kysely<Database>;
  subs: NotificationsRepository;
  sender?: PushSender;
  /** Test escape hatch; production leaves it undefined and loads/generates VAPID from the data dir. */
  vapid?: { publicKey: string; privateKey: string; subject: string };
}

export function createNotifyService(deps: NotifyServiceDeps) {
  const send: PushSender =
    deps.sender ??
    ((sub, payload) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 3600 },
      ));

  async function keys() {
    if (deps.vapid) return deps.vapid;
    return loadOrGenerateVapid();
  }

  return {
    async vapidPublicKey(): Promise<string> {
      return (await keys()).publicKey;
    },
    /**
     * Ring every one of the session OWNER's devices — but only if the
     * session's bell is on. Send-time gate: flipping the bell takes effect
     * on the next event with nothing to invalidate. A dead endpoint (404/410)
     * is pruned; every other failure keeps the row (transient).
     */
    async notifySession(sessionId: string, kind: NotifyKind): Promise<void> {
      try {
        const row = await new SessionsRepository(deps.sessions).findById(sessionId);
        if (!row || row.notify !== 1) return;
        const subs = await deps.subs.listByUser(row.userId);
        if (subs.length === 0) return;
        const payload = JSON.stringify(buildNotificationPayload(row, kind));
        // web-push needs applicationServerDetails applied per send, not just once:
        const { publicKey, privateKey, subject } = await keys();
        webpush.setVapidDetails(subject, publicKey, privateKey);
        for (const sub of subs) {
          try {
            await send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await deps.subs.deleteByEndpoint(sub.endpoint);
            } else {
              logger.withError(err).warn(`push send failed (kept): ${sub.endpoint.slice(0, 60)}…`);
            }
          }
        }
      } catch (err) {
        // Notifications must never break the caller (sweep / hook route).
        logger.withError(err).warn(`notifySession(${sessionId}, ${kind}) failed`);
      }
    },
  };
}

export type NotifyService = ReturnType<typeof createNotifyService>;

let singleton: NotifyService | null = null;

/** The app-wide service (shared `db` + its own repository + real sender). */
export function getNotifyService(): NotifyService {
  singleton ??= createNotifyService({
    // The typed app db is structurally the same Kysely<Database> the
    // repositories already take everywhere.
    sessions: db,
    subs: new NotificationsRepository(db),
  });
  return singleton;
}
```

(`db` comes from `import { db } from "@/db/index.js";` — the same import every repository-using module has.)

`loadOrGenerateVapid()` (same file, module-private, plus two exported test seams following the singleton rule):

```ts
const VAPID_FILE = "vapid.json";

let cachedVapid: { publicKey: string; privateKey: string; subject: string } | null = null;
let vapidDirOverride: string | null = null;

/** @internal Test isolation: read VAPID keys from `dir` instead of SESSION_DATA_DIR. */
export function __setVapidDirForTests(dir: string | null): void {
  vapidDirOverride = dir;
  cachedVapid = null;
}

/** Load the instance's VAPID pair, generating and persisting it on first use. */
function loadOrGenerateVapid() {
  if (cachedVapid) return cachedVapid;
  const dir = vapidDirOverride ?? SESSION_DATA_DIR;
  const file = join(dir, VAPID_FILE);
  mkdirSync(dir, { recursive: true });
  try {
    cachedVapid = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    const g = webpush.generateVAPIDKeys();
    cachedVapid = { publicKey: g.publicKey, privateKey: g.privateKey, subject: "mailto:mote@localhost" };
    writeFileSync(file, JSON.stringify(cachedVapid), { mode: 0o600 });
    logger.info(`generated VAPID keys → ${file}`);
  }
  return cachedVapid;
}
```

- [ ] **Step 5: Run tests → pass. Full trio. Commit**

```bash
git add apps/backend packages/harnesses bun.lock && git commit -m "feat(sessions): notify service with VAPID keys, bell gate, endpoint pruning"
```

---

### Task 4: notifications.route.ts — config / subscribe / unsubscribe (cookie-only)

**Files:**
- Create: `apps/backend/src/api/notifications.route.ts`
- Modify: `apps/backend/src/api/routes.ts` (import + `.use(notificationsRoutes)`)
- Test: `apps/backend/src/api/__tests__/notifications-route.test.ts`

**Interfaces:**
- Consumes: `authGuard` (user, actor), `getNotifyService().vapidPublicKey()`, `NotificationsRepository.upsertForUser/deleteForUser`, `HttpError`.
- Produces:
  - `GET /api/notifications/config` → `{ publicKey: string, vapidConfigured: boolean }` (503 → `{vapidConfigured:false}` when keys cannot be created).
  - `POST /api/notifications/subscribe` body `{endpoint, p256dh, auth}` → `{ok:true}`.
  - `POST /api/notifications/unsubscribe` body `{endpoint}` → `{ok:true}`.
  All cookie-only; machine bearers 403 (browser affordance, like the files routes).

- [ ] **Step 1: Failing test** — same suite skeleton as `files-route.test.ts` (`setupAuthTables`, `signIn`, real `filesRoutes.fetch(Request)` style but on `notificationsRoutes`):

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { notificationsRoutes } from "@/api/notifications.route.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { __setVapidDirForTests } from "@/services/notify.service.js";

describe("notifications route", () => {
  const email = `notif-${crypto.randomUUID()}@mote.local`;
  const password = "notif-pass-1234";
  let cookie: string;
  const vapidDir = mkdtempSync(join(tmpdir(), "mote-vapid-"));

  beforeAll(async () => {
    __setVapidDirForTests(vapidDir);
    await setupAuthTables();
    await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(password), role: "user" });
    cookie = await signIn(email, password);
  });
  afterAll(async () => {
    await db.deleteFrom("notificationsSubscriptions").execute();
    await deleteUserByEmailOrId(email);
    __setVapidDirForTests(null);
    rmSync(vapidDir, { recursive: true, force: true });
  });

  function req(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("cookie", `better-auth.session_token=${cookie}`);
    return notificationsRoutes.fetch(new Request(`http://localhost:3080/api/notifications${path}`, { ...init, headers }));
  }
  const json = (b: unknown) => JSON.stringify(b);

  it("GET /config returns the public key and persists vapid.json", async () => {
    const body = (await (await req("/config")).json()) as { publicKey: string; vapidConfigured: boolean };
    expect(body.vapidConfigured).toBe(true);
    expect(body.publicKey.length).toBeGreaterThan(30);
    expect(existsSync(join(vapidDir, "vapid.json"))).toBe(true);
  });

  it("subscribe stores the caller's subscription; unsubscribe removes it", async () => {
    const res = await req("/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json({ endpoint: "https://push/x", p256dh: "k1", auth: "a1" }),
    });
    expect(res.status).toBe(200);
    const rows = await db.selectFrom("notificationsSubscriptions").selectAll().execute();
    expect(rows.map((r) => r.endpoint)).toContain("https://push/x");
    const off = await req("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json({ endpoint: "https://push/x" }),
    });
    expect(off.status).toBe(200);
  });

  it("subscribe validates the body (short endpoint → 400)", async () => {
    const res = await req("/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json({ endpoint: "", p256dh: "k", auth: "a" }),
    });
    expect(res.status).toBe(400);
  });

  it("unauthenticated → 401", async () => {
    // A request builder that never attaches the cookie — no mutating shared
    // state between tests.
    const anon = (path: string) =>
      notificationsRoutes.fetch(new Request(`http://localhost:3080/api/notifications${path}`));
    expect((await anon("/config")).status).toBe(401);
    expect((await anon("/subscribe")).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** `notifications.route.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard, HttpError } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import { getNotifyService } from "@/services/notify.service.js";

/**
 * Per-device Web Push subscriptions (spec 2026-08-30-harness-notifications).
 *
 * Cookie-only like the files routes: enabling push on a device is a
 * human-in-the-browser act; machine credentials get 403. Whether any
 * notification is ever SENT is decided per session by `sessions.notify`,
 * checked at send time — this route is plumbing, not policy.
 */

const SubscribeBodySchema = t.Object({
  endpoint: t.String({ minLength: 10, maxLength: 4096, description: "Push endpoint URL from pushManager.subscribe()" }),
  p256dh: t.String({ minLength: 10, maxLength: 256, description: "P-256 ECDH public key (base64url)" }),
  auth: t.String({ minLength: 5, maxLength: 256, description: "Auth secret (base64url)" }),
});

const UnsubscribeBodySchema = t.Object({
  endpoint: t.String({ minLength: 10, maxLength: 4096, description: "Endpoint to forget" }),
});

const ConfigResponseSchema = t.Object({
  publicKey: t.String({ description: "VAPID public key ('' when unconfigured)" }),
  vapidConfigured: t.Boolean({ description: "False when the data dir cannot hold vapid.json" }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

function browserOnly(actor: string): void {
  if (actor !== "cookie") throw new HttpError(403, "Notifications are restricted to browser sessions");
}

export const notificationsRoutes = new Elysia({ prefix: "/api/notifications" })
  .use(authGuard)
  .get(
    "/config",
    async ({ actor }) => {
      browserOnly(actor);
      try {
        return { publicKey: await getNotifyService().vapidPublicKey(), vapidConfigured: true };
      } catch {
        return { publicKey: "", vapidConfigured: false };
      }
    },
    {
      response: { 200: ConfigResponseSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: { operationId: "notificationsConfig", tags: ["notifications"], description: "VAPID public key (browser sessions only)" },
    },
  )
  .post(
    "/subscribe",
    async ({ body, user, actor }) => {
      browserOnly(actor);
      await new NotificationsRepository(db).upsertForUser(user.id, body.endpoint, body.p256dh, body.auth);
      return { ok: true } as const;
    },
    {
      body: SubscribeBodySchema,
      response: { 200: OkResponseSchema, 400: "ApiErrorResponse", 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: { operationId: "subscribePush", tags: ["notifications"], description: "Store this browser's push subscription" },
    },
  )
  .post(
    "/unsubscribe",
    async ({ body, user, actor }) => {
      browserOnly(actor);
      await new NotificationsRepository(db).deleteForUser(user.id, body.endpoint);
      return { ok: true } as const;
    },
    {
      body: UnsubscribeBodySchema,
      response: { 200: OkResponseSchema, 400: "ApiErrorResponse", 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: { operationId: "unsubscribePush", tags: ["notifications"], description: "Forget this browser's push subscription" },
    },
  );
```

Mount in `routes.ts` after `.use(filesRoutes)`: `.use(notificationsRoutes)` (import alongside).

- [ ] **Step 4: Run → pass; trio; turbo build (backend-client types see the new routes); commit** `feat(api): push subscription endpoints (cookie-only)`.

---

### Task 5: Attention + bell-toggle routes, sessions service methods

**Files:**
- Create: `apps/backend/src/api/sessions/session-attention.route.ts`
- Create: `apps/backend/src/api/sessions/update-session-notify.route.ts`
- Modify: `apps/backend/src/api/sessions/index.ts` (mount both)
- Modify: `apps/backend/src/services/sessions.service.ts` (`setSessionNotify`, `recordAttention`)
- Modify: `apps/backend/src/services/session-manager.service.ts` (nothing here — reuse `sessions.update` via service repositories; see below)
- Test: extend `apps/backend/src/api/__tests__/sessions-rename-route.test.ts` style into a new `apps/backend/src/api/__tests__/sessions-notify-route.test.ts`

**Interfaces:**
- Consumes: `authGuard` (actor/principal), `requirePerm`, `HttpError`, `getNotifyService()`, `SessionsRepository.update`.
- Produces:
  - `POST /api/sessions/:id/attention` body `{kind: "turn_complete" | "needs_attention"}` — **session-key actor only** (cookie actors get 403: this is the harness talking, not a browser), self-scoped. Sets `waiting_since=now` and calls `notifySession(id, kind)`. `{ok:true}`.
  - `PATCH /api/sessions/:id/notify` body `{notify: boolean}` — cookie (owner) or the session's own key; false→`waiting_since` untouched (muting stops pushes, not the state). `{ok:true}`, 404 when not owner.
  - `SessionsService.setSessionNotify(userId, id, notify): Promise<boolean>`; `SessionsService.recordAttention(id, kind): Promise<void>` (sets waiting_since, fires notify best-effort).

- [ ] **Step 1: Failing tests** (`sessions-notify-route.test.ts`, mirroring the rename suite's helpers — cookie `signIn`, `mintSessionKey` from the files-route suite pattern; import `__setVapidDirForTests` and point it at a temp dir so notify sends never touch the real data dir):

```ts
it("attention from the session's own key sets waiting_since and rings", async () => {
  // create session row with notify=1, mint its key, POST attention
  const res = await req(`/api/sessions/${id}/attention`, bearer(key), { kind: "turn_complete" });
  expect(res.status).toBe(200);
  const row = await new SessionsRepository(db).findById(id);
  expect(row?.waitingSince).not.toBeNull();
});
it("attention with a foreign session key → 403; cookie actor → 403; unknown kind → 400", …);
it("PATCH notify toggles the bell both ways; foreign cookie user → 404", …);
it("PATCH notify from the session's own key is allowed for itself, not others", …);
```

Write all five with the same request helpers as `sessions-rename-route.test.ts`.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3a: service methods** (`sessions.service.ts`, next to `setSessionAutoTitle`):

```ts
  /** Rings or mutes a session's notifications (the ⋯-menu bell). */
  async setSessionNotify(userId: string, id: string, notify: boolean): Promise<boolean> {
    const row = await this.#sessions.findById(id);
    if (!row || row.userId !== userId) return false;
    await this.#sessions.update(id, { notify: notify ? 1 : 0 });
    return true;
  }

  /**
   * A harness reports it needs attention (hook delivery). Sets the waiting
   * stamp and rings — the bell gate lives inside notifySession so this path
   * is unconditional here.
   */
  async recordAttention(id: string, kind: "turn_complete" | "needs_attention"): Promise<void> {
    await this.#sessions.update(id, { waitingSince: new Date().toISOString() });
    await getNotifyService().notifySession(id, kind);
  }
```

**3b: routes.** `session-attention.route.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const AttentionBodySchema = t.Object({
  kind: t.Union([t.Literal("turn_complete"), t.Literal("needs_attention")], {
    description: "What the harness is reporting: the turn finished, or it needs the operator",
  }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/**
 * `POST /api/sessions/:id/attention` — the harness self-report endpoint the
 * injected hooks call. Session-key-only and self-scoped (the same rule as
 * /name and /notes): a harness may ring its OWN session's bell, never
 * another's, and browsers have no reason to be here (they get the state via
 * the session feed).
 */
export const sessionAttentionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/attention",
    async ({ params, body, actor, principal, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "write");
      if (actor !== "session-key" || principal !== `sess:${params.id}`) {
        throw new HttpError(403, "Only a session's own key may report attention");
      }
      await ctx.services.sessions.recordAttention(params.id, body.kind);
      return { ok: true } as const;
    },
    {
      body: AttentionBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: { operationId: "reportSessionAttention", tags: ["sessions"], description: "Harness self-report: waiting for the operator" },
    },
  );
```

`update-session-notify.route.ts` — exact copy of the rename route's shape with `{notify: t.Boolean({description: "true = ring this session; false = silent"})}`, guard `if (actor === "session-key" && principal !== \`sess:${params.id}\`) throw new HttpError(403, …)`, then `if (!(await ctx.services.sessions.setSessionNotify(user.id, params.id, body.notify))) throw new HttpError(404, "Session not found")`, `detail.operationId: "setSessionNotify"`.

Mount both in `sessions/index.ts` after `updateSessionNotesRoute`:
`.use(updateSessionNotifyRoute)` `.use(sessionAttentionRoute)`.

- [ ] **Step 4: Run → pass; trio; commit** `feat(sessions): attention self-report + bell toggle routes`.

---

### Task 6: Exit/crash notifications + waiting-clear on death (reconcile)

**Files:**
- Modify: `apps/backend/src/services/session-manager.service.ts` (`reconcileRows` death branches; constructor `notify` seam)
- Test: `apps/backend/src/services/__tests__/session-manager.service.test.ts` (extend the notes+restart describe)

**Interfaces:**
- Consumes: injected `notify: (id, kind) => Promise<void>` constructor dep; `SessionUpdate.waitingSince`.
- Produces: on the alive→dead transition (only transition, so backoff sweeps don't repeat): `waitingSince: null` in the death patch and `this.#notify(row.id, row.restartOnExit === 1 ? "crashed" : "exited")` after it. The manual `terminateSession` path deliberately does NOT notify (the operator clicked it).

- [ ] **Step 1: Failing tests** — extend the service suite: construct a manager with a `notify` spy dep; seed a live-looking running row with `waitingSince` set and a tmuxSocket that does not exist; `reconcileAll()`; assert the row shows `alive=0, waitingSince=null` and the spy recorded `("id","exited")`. Second case: `restartOnExit: 1` → spy records `"crashed"`. Third: row was `alive=0` already → spy not called (no re-notification).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** Constructor gains `notify?: (sessionId: string, kind: NotifyKind) => Promise<void>` defaulting to `async (id, kind) => { await getNotifyService().notifySession(id, kind); }` (store as `#notify`). In `reconcileRows`, both death branches (the no-socket branch and the `hasSession===false` branch where `row.alive === 1`) add `waitingSince: null` to their update patch, and call `void this.#notify(row.id, row.restartOnExit === 1 ? "crashed" : "exited")` after the update. Import `NotifyKind` from `@/services/notify.service.js`. The default import must be a lazy `await getNotifyService()` inside the function to keep unit suites that pass a spy from loading web-push.

- [ ] **Step 4: Run → pass; trio; commit** `feat(sessions): notify on session exit/crash and clear waiting on death`.

---

### Task 7: The idle watcher (universal tier) + boot wiring

**Files:**
- Create: `apps/backend/src/services/notify-idle.ts`
- Modify: `apps/backend/src/index.ts` (start the 3 s tick next to the reconcile interval)
- Test: `apps/backend/src/services/__tests__/notify-idle.test.ts`

**Interfaces:**
- Consumes: `SessionsRepository.listRunning()` (rows incl. `notify`, `waitingSince`, `harnessId`, `alive`, `tmuxSocket`), `sessionLogPath(id)` (session-manager exports it), `getHarness(id)?.supportsAttentionHooks`, injected notify/setWaiting/clearWaiting.
- Produces: `createIdleWatcher(deps): { tick(nowMs: number): Promise<void> }` with deps `{ listRows, statMtimeMs(id) → Promise<number|null>, harnessHasHooks(id): boolean, notifySession(id, kind), setWaiting(id), clearWaiting(id) }` and exported consts `IDLE_QUIET_MS = 20_000`, `IDLE_TICK_MS = 3_000`. Production wiring in `index.ts` builds deps from the real repos/`Bun.file(...).stat()`/getNotifyService, then `setInterval(() => void watcher.tick(Date.now()), IDLE_TICK_MS)`.

**Firing rule (the whole class is this):** for rows with `alive === 1`: stat the log; unseen mtime → store state `{mtime, fired: false}`, never fire (a session already idle at boot must not ring). mtime grew → if `row.waitingSince` set → `clearWaiting`; store new mtime. mtime unchanged AND quiet ≥ IDLE_QUIET_MS AND `!fired` → `fired = true`; then if `!harnessHasHooks(row.harnessId)` → `notifySession(id, "turn_complete")` and `setWaiting(id)` (hooked harnesses get the chip from their hook — the watcher only owns CLEARING for them). A fire for `waitingSince` purposes fires regardless of the bell (the bell gates the PUSH inside notifySession, not the waiting state — but for hooked harnesses the watcher never touches waiting; for hook-less harnesses setWaiting belongs here).

- [ ] **Step 1: Failing tests** — a fake deps table with a mutable clock and a mutable `Map<id, mtime>`; assert: (a) first tick only seeds state — no notify/no clear; (b) quiet ≥ 20 s hook-less row fires exactly once; a second quiet tick does not re-fire; (c) mtime growth clears waiting and re-arms (next quiet fires again); (d) hooked harness (`harnessHasHooks → true`): never notifies/setWaiting, but DOES clearWaiting on growth; (e) `alive === 0` rows ignored.

- [ ] **Step 2: Run → fail. Step 3: Implement the class per the rule above; wire `index.ts`.**

- [ ] **Step 4: Run → pass; trio; commit** `feat(sessions): quiet-output idle watcher for hook-less harnesses`.

---

### Task 8: SessionView fields + WaitingChip + list ordering (frontend)

**Files:**
- Modify: `apps/backend/src/services/session-manager.service.ts` (`toSessionView` input+output: `notify`, `waitingSince`)
- Modify: `apps/frontend/src/types/session.ts` (`notify: boolean`, `waitingSince: string | null` with JSDoc)
- Create: `apps/frontend/src/lib/session-order.ts` — `isWaiting(s): boolean`, `priorityRunning(sessions): SessionView[]` (stable; `notify && isWaiting` first, then the rest untouched)
- Create: `apps/frontend/src/components/waiting-chip.tsx` — amber `Badge variant="warning"` reading "waiting for you", rendered only when `isWaiting(session)`
- Modify: `apps/frontend/src/routes/index.tsx` — `groups.running = priorityRunning(groups.running)` where `groups` is built (line ~58 `groupSessions(filtered)`; mutate the running bucket after)
- Modify: `apps/frontend/src/components/session-card.tsx` — accessory: when `isWaiting(session)` render `<WaitingChip/>` INSTEAD of the activity badge (waiting outranks "working"/"idle" copy)
- Modify: `apps/frontend/src/components/session-manager-table.tsx` — Status cell: `{isWaiting(s) && <WaitingChip session={s} />}` after `<StatusChip session={s} />`
- Test: `apps/frontend/src/lib/__tests__/session-order.test.ts`; extend any session-card/table tests that construct a `SessionView` (add the two fields to fixtures)

**Interfaces:** Produces `isWaiting`, `priorityRunning`, `<WaitingChip>` (used by Task 9's menu label copy and nowhere else).

- [ ] **Step 1: Failing session-order tests** — `priorityRunning` puts notify+waiting first, keeps relative order of the rest (input `[{a waiting+bell},{b waiting no bell},{c running no waiting},{d bell no waiting}]` → `[{a},{b},{c},{d}]`); `isWaiting` false for dead/exited rows even with `waitingSince` set (stale stamp guard: `status==="running" && alive`).
- [ ] **Step 2: Run → fail. Step 3: Backend view fields** — add `notify: number; waitingSince: string | null;` to the `toSessionView` row parameter type and `notify: row.notify === 1, waitingSince: row.waitingSince` to the returned object (after `nameLocked`). `sessions/index` list endpoints select all columns already.
- [ ] **Step 4: Frontend type + components + wiring + fixtures** per Files.
- [ ] **Step 5: Trio (backend tests may need SessionView-mirror fixtures updated); commit** `feat(frontend): waiting-for-you chip + bell-first ordering`.

---

### Task 9: The bell in the ⋯ menu

**Files:**
- Modify: `apps/frontend/src/hooks/use-session-mutations.ts` (`toggleNotify`, mirror `toggleTitleLock`)
- Modify: `apps/frontend/src/components/session-actions-menu.tsx` (Bell/BellOff item between Pin and Terminate)
- Test: `apps/frontend/src/components/__tests__/session-actions-menu.test.tsx` (new)

**Interfaces:** Consumes `PATCH /api/sessions/:id/notify` (Task 5). Produces `SessionMutations.toggleNotify: () => Promise<void>`.

- [ ] **Step 1: Failing component test** — render `<SessionActionsMenu session={{...fixture, notify:false}}/>`, open the menu (base-ui: `userEvent` or `fireEvent.click` on the trigger), assert a "Notify when done" item exists; click it; assert fetch mocked at `globalThis` got `PATCH /api/sessions/<id>/notify` with `{"notify":true}`. Second case `notify:true` → item labeled "Mute notifications", body `{"notify":false}`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** In the hook (copy `toggleTitleLock`'s shape): `apiFetch(\`/api/sessions/${id}/notify\`, { method: "PATCH", body: JSON.stringify({ notify: session?.notify !== true }) })`, invalidate `SESSIONS_QUERY_KEY` + `SESSION_QUERY_KEY(id)`; expose `toggleNotify`. In the menu, after the pin item:

```ts
    session.notify
      ? { icon: BellOff, label: "Mute notifications", onSelect: () => void toggleNotify() }
      : { icon: Bell, label: "Notify when done", onSelect: () => void toggleNotify() },
```

- [ ] **Step 4: Run → pass; trio; commit** `feat(frontend): per-session notification bell in the actions menu`.

---

### Task 10: Service worker + enable-on-device UI

**Files:**
- Create: `apps/frontend/public/sw-handlers.js` (plain script; defines `self.MoteSw = { shouldShow, noteOptions, clickTarget }`)
- Create: `apps/frontend/public/sw.js` (`importScripts("/sw-handlers.js")` + event plumbing only)
- Create: `apps/frontend/src/lib/notifications.ts` (`getPushState()`, `enablePush()`, `disablePush()`)
- Create: `apps/frontend/src/components/notifications-card.tsx`
- Modify: `apps/frontend/src/routes/settings.tsx` (render `<NotificationsCard />` above `<SystemApiKeysCard />`)
- Test: `apps/frontend/src/lib/__tests__/sw-handlers.test.ts` (load the plain script text, eval into a fake `self`, assert the three functions), `apps/frontend/src/lib/__tests__/notifications.test.ts` (mocked fetch + stubbed `pushManager`)

**Interfaces:**
- `sw-handlers.js` (loaded by the SW, evaluated by tests):
  - `shouldShow(data, focusedClientUrl)` — false when a focused client URL contains the payload's `url` (you're already looking at it), true otherwise.
  - `noteOptions(data)` — `{ title: data.title, body: data.body, tag: data.tag, data }`.
  - `clickTarget(data)` — `new URL(data.url, self.location.origin).href`.
- `sw.js` — classic worker: on `push` → `event.waitUntil(clients.matchAll({type:"window"}))` → find `focused` → `shouldShow` → `self.registration.showNotification(...)`; on `notificationclick` → close the note, `clickTarget`, then focus a client whose URL starts with the target origin+path… simpler contract: focus the first client whose URL contains `data.url`, else `clients.openWindow(target)`.
- `notifications.ts`: `enablePush()` = GET `/api/notifications/config` → `navigator.serviceWorker.register("/sw.js")` → `Notification.requestPermission()` → `reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey: urlBase64ToUint8Array(publicKey)})` → POST subscribe with `{endpoint, keys.p256dh, keys.auth}`; returns a state string `"on" | "blocked" | "unsupported" | "unconfigured" | "off"`. `getPushState()` = permission + `getSubscription()` presence. `disablePush()` = unsubscribe the PushSubscription object, then POST unsubscribe. `urlBase64ToUint8Array` lives here (7-line helper), tested.

- [ ] **Step 1: Failing sw-handlers tests** (eval-script-into-fake-self pattern):

```ts
import { describe, expect, it } from "bun:test";

async function loadHandlers(): Promise<Record<string, (…args: never[]) => unknown>> {
  const src = await Bun.file(new URL("../../../public/sw-handlers.js", import.meta.url)).text();
  const scope: { self: Record<string, unknown> } = { self: { location: { origin: "https://mote.test" } } };
  new Function("self", src)(scope.self);
  return scope.self.MoteSw as never;
}
```

assert: `shouldShow({url:"/sessions/x"}, "https://mote.test/sessions/x")` → false; focused null → true; `noteOptions` shape; `clickTarget` absolute URL.

- [ ] **Step 2: Fail → implement `sw-handlers.js` + `sw.js`.**
- [ ] **Step 3: Failing notifications.test.ts** (stub `globalThis.fetch`, `navigator` guards — happy-dom may lack `navigator.serviceWorker`; the lib must degrade to `"unsupported"` when `!("serviceWorker" in navigator) || !("PushManager" in window)`, tested).
- [ ] **Step 4: Fail → implement `notifications.ts`, then `NotificationsCard`** — a Card (same primitives as settings.tsx) with a button whose label comes from `getPushState()`; blocked state shows "Allow notifications for mote in your browser/OS settings."; iOS Safari (UA `/(iPhone|iPad)/.test(navigator.userAgent) && !("serviceWorker" in navigator) || push unsupported`) shows the Add-to-Home-Screen note. Keep the card's logic thin and put nothing clever in it that the lib didn't already decide.
- [ ] **Step 5: Trio + commit** `feat(frontend): service worker + enable-notifications settings card`.

---

### Task 11: End-to-end proof (production browser)

No new code except fixes discovered while verifying.

- [ ] **Step 1:** full trio one last time; `docker compose build && docker compose up -d`; boot log clean, migration 0014 line present.
- [ ] **Step 2:** Desktop Chrome: Settings → enable (accept OS permission). Session → ⋯ → "Notify when done". Type a prompt in the session, wait for the turn to finish → Chrome shows "resume-verify / Done — waiting for you" with the tab backgrounded. Click → lands on `/sessions/<id>`.
- [ ] **Step 3:** Confirm the chip: bell-ON session shows amber "waiting for you" on the home list and sorts first in Running; mute → chip behavior stays, pushes stop (verify with a second turn).
- [ ] **Step 4:** Kill the pane from outside (`tmux -L <sock> kill-session` via `docker exec`) → reconcile marks exited → push "Crashed — auto-restarting" or "Session exited" depending on the profile.
- [ ] **Step 5:** Hook-less path: start a `shell`/hermes-type session with the bell ON, produce output, go quiet 20 s → notification arrives.
- [ ] **Step 6:** Report: phone push requires the user's own device step (Add to Home Screen on iPhone / enable in Android Chrome) — capture what the card shows and hand off.
- [ ] **Step 7:** Commit any fixes as `fix(...)` with tests; `git push` only when the user says.

---

## Self-review notes (author, after writing)

- Spec coverage: events (turn/approval/exit) → Tasks 2/5/6/7; bell policy → 1/5/9; waiting state + chip + sort → 1/5/6/7/8; VAPID-in-/data → 3; cookie-only device endpoints + self-scoped harness endpoint → 4/5; SW click/suppression → 10; pruning → 3; test list mirrored 1:1. iPhone hint → Task 10 card. "Out of scope" items are untouched by all tasks. ✔
- One intentional deviation from spec wording: spec said the SW would be a module with importable pure logic; plan keeps a classic worker + a plain `sw-handlers.js` loaded via `importScripts` and eval'd into a fake `self` by tests — same testability promise, zero build changes. ✔
- Type consistency checked: `NotifyKind` defined in Task 3, consumed 5/6/7; `notify`/`waitingSince` names identical in migration (snake), Kysely types (camel), view, frontend; `supportsAttentionHooks` identical in 2/7. ✔
