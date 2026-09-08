# Mobile Native Backend Push Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the entire server-side diff of the native mobile app spec: device-token storage, `POST/DELETE /api/devices`, `GET /api/sessions/summary`, and an Expo push transport fanned out from `notifySession` with an opaque payload.

**Architecture:** Purely additive on top of the existing web-push service (`src/services/notify.service.ts`). A new `device_tokens` table + repository mirrors `notifications_subscriptions`; a new `expo-push.ts` module owns message construction and a `PushSender`-style fakeable seam; `notifySession` gains a second fan-out loop gated by the same per-session bell. Auth is untouched — the devices route is cookie-only like the notifications route.

**Tech Stack:** Bun, ElysiaJS (TypeBox `t`), Kysely + `bun:sqlite`, `expo-server-sdk` 7.2.0, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-31-mobile-native-app-design.md` (§Backend diff, §Push, §Invariants). M1/M2 (scaffold + mobile transport layer) already merged.

## Global Constraints

- **Invariant 1 — no auth change:** `api/ws-token.route.ts:26` and `api/notifications.route.ts:41` keep rejecting bearer actors exactly as written; the devices route joins that posture, it does not weaken it.
- **Invariant 2 — web push untouched:** `buildNotificationPayload` and `src/services/__tests__/notify.service.test.ts` must pass **unmodified**. The device transport is additive; a service built without it behaves byte-identically.
- **Invariant 6 — opaque relay payload:** nothing crossing `exp.host` may contain a session name, working directory, note, or operator text. Only: token, `"mote"`, `KIND_COPY[kind]`, an integer badge, the session uuid, the kind, and the instance origin.
- **Invariant 3 — the terminal transport does not fork.** (No task here touches `/ws`.)
- Every Elysia `t` schema property carries a `description` (`.claude/rules/code-style.md`).
- No dynamic imports anywhere (`.claude/rules/code-style.md`).
- Versions pinned exactly; `bun add` then `bunx syncpack fix && bun install` (`.claude/rules/dependencies.md`, `package-manager.md`). **Watch syncpack's repo-wide edits** — never commit a drive-by dependency bump into `apps/frontend`/`apps/backend` from unrelated work (`apps/mobile/AGENTS.md`).
- New migration must exist in `src/db/migrations/` **and** be registered in the static provider map in `src/db/migrate.ts`; file name = map key (app `AGENTS.md`).
- After every task, from the repo root: `bun run verify-types && bun run lint:check && bun run test` must exit 0 before committing.
- Backend route changes must be followed by `turbo build` so `@internal/backend-client` types see them (`.claude/rules/build.md`) — Task 7 runs it once after the routes land.
- Commits: conventional style as used by `git log`; author `theo@suteki.nu`.

---

### Task 1: Migration `0015-device-push-tokens`

**Files:**
- Create: `apps/backend/src/db/migrations/0015-device-push-tokens.ts`
- Create: `apps/backend/src/db/types/device-tokens.db-types.ts`
- Create: `apps/backend/src/db/migrations/__tests__/0015-device-push-tokens.test.ts`
- Modify: `apps/backend/src/db/migrate.ts` (import + provider-map entry)
- Modify: `apps/backend/src/db/types/index.ts` (`Database` interface)

**Interfaces:**
- Consumes: nothing new.
- Produces: table `device_tokens` (`id, user_id, token UNIQUE, platform, created_at, updated_at`); type `DeviceTokenTable` and `DevicePlatform = "ios" | "android"` from `@/db/types/device-tokens.db-types.js`.

- [ ] **Step 1: Write the failing migration test**

Create `apps/backend/src/db/migrations/__tests__/0015-device-push-tokens.test.ts`, mirroring the 0014 test (`0014-session-notifications.test.ts`):

```ts
import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as deviceTokensMigration from "@/db/migrations/0015-device-push-tokens.js";
import { openSqliteDatabase } from "@/db/open-database.js";

async function migratedDb() {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  return db;
}

describe("migration 0015-device-push-tokens", () => {
  it("creates device_tokens and enforces a unique token", async () => {
    const db = await migratedDb();
    await deviceTokensMigration.up(db);
    const insert = (token: string) =>
      db
        .insertInto("deviceTokens")
        .values({
          id: crypto.randomUUID(),
          userId: "u1",
          token,
          platform: "ios",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
        })
        .execute();
    await insert("ExponentPushToken[aaaa]");
    await expect(insert("ExponentPushToken[aaaa]")).rejects.toThrow();
    // Column name on the wire is snake_case; prove the migration really used it.
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('device_tokens')`
      .execute(db)
      .then((r) => r.rows);
    expect(cols.map((c) => c.name).sort()).toEqual(
      ["created_at", "id", "platform", "token", "updated_at", "user_id"].sort(),
    );
    await db.destroy();
  });

  it("down() drops the table", async () => {
    const db = await migratedDb();
    await deviceTokensMigration.up(db);
    await deviceTokensMigration.down(db);
    await expect(
      sql`SELECT 1 FROM device_tokens`.execute(db),
    ).rejects.toThrow();
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0015-device-push-tokens.test.ts`
Expected: FAIL — cannot resolve `@/db/migrations/0015-device-push-tokens.js`.

- [ ] **Step 3: Write the migration**

Create `apps/backend/src/db/migrations/0015-device-push-tokens.ts` (style mirrors 0014):

```ts
import type { Kysely } from "kysely";

/**
 * Native-device push tokens (spec 2026-08-31-mobile-native-app):
 *
 * - `device_tokens`: one row per enrolled phone/tablet, owned by a user.
 *   `token` is unique — an Expo push token IS the device's mailbox (OS
 *   restore / reinstall can hand it to a different account), so a
 *   re-enrollment replaces the row rather than duplicating or failing.
 * - `platform`: 'ios' | 'android' — recorded for ops/debugging only; the
 *   Expo relay routes by the token itself.
 * - `updated_at`: bumped on every (re-)enrollment; enrollment happens on
 *   every cold start, so token churn stays bounded.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("device_tokens")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("token", "text", (c) => c.notNull())
    .addColumn("platform", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("idx_device_tokens_token")
    .unique()
    .on("device_tokens")
    .column("token")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("device_tokens").execute();
}
```

- [ ] **Step 4: Register it in the static provider map**

Modify `apps/backend/src/db/migrate.ts`: add the import after the 0014 import, and the map entry after `"0014-session-notifications"`:

```ts
import * as devicePushTokensMigration from "@/db/migrations/0015-device-push-tokens.js";
// …
"0015-device-push-tokens": devicePushTokensMigration,
```

The key MUST equal the file name minus `.ts` — the boot migrator reads this static map (a dynamic import would break `bun build --compile`).

- [ ] **Step 5: Add the row type and wire it into `Database`**

Create `apps/backend/src/db/types/device-tokens.db-types.ts`:

```ts
/** OS the token was minted on — recorded for diagnostics; Expo routes by token. */
export type DevicePlatform = "ios" | "android";

/**
 * Database table schema for one enrolled native device (Expo push token).
 * Owned by the user who last signed in on it.
 */
export interface DeviceTokenTable {
  /** Unique row id (uuid) */
  id: string;
  /** Owner of this device */
  userId: string;
  /** Expo push token (`ExponentPushToken[...]`) — globally unique */
  token: string;
  /** OS the token belongs to */
  platform: DevicePlatform;
  /** ISO 8601 timestamp when first stored */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent (re-)enrollment */
  updatedAt: string;
}
```

Modify `apps/backend/src/db/types/index.ts`: import `DeviceTokenTable` alongside the others and add the member to `Database`:

```ts
import type { DevicePlatform, DeviceTokenTable } from "@/db/types/device-tokens.db-types.js";
// … inside interface Database:
deviceTokens: DeviceTokenTable;
```

(`DevicePlatform` is imported where used later; add the member only for `DeviceTokenTable` here — do not re-export types that are already importable from their source, per `.claude/rules/code-style.md`.)

- [ ] **Step 6: Run the migration test — expect PASS**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0015-device-push-tokens.test.ts`

- [ ] **Step 7: Full verification, then commit**

```bash
cd /home/theo/projects/mote
bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/db/migrations/0015-device-push-tokens.ts \
        apps/backend/src/db/migrations/__tests__/0015-device-push-tokens.test.ts \
        apps/backend/src/db/types/device-tokens.db-types.ts \
        apps/backend/src/db/types/index.ts \
        apps/backend/src/db/migrate.ts
git commit -m "feat(backend): migration 0015 device_tokens + row type"
```

---

### Task 2: `DeviceTokensRepository`

**Files:**
- Create: `apps/backend/src/db/repositories/device-tokens.repository.ts`
- Create: `apps/backend/src/db/repositories/__tests__/device-tokens.repository.test.ts`

**Interfaces:**
- Consumes: `deviceTokens` table (Task 1), `DeviceTokenTable`, `DevicePlatform`.
- Produces: `new DeviceTokensRepository(db)` with
  `upsertForUser(userId: string, token: string, platform: DevicePlatform): Promise<void>`,
  `listByUser(userId: string): Promise<DeviceTokenTable[]>`,
  `deleteForUser(userId: string, token: string): Promise<void>`,
  `deleteByToken(token: string): Promise<void>` — the exact shape of `NotificationsRepository` with `endpoint`→`token`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/db/repositories/__tests__/device-tokens.repository.test.ts` (fresh in-memory DB per suite — the repo-level convention used by `notifications` coverage and the migration tests):

```ts
import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as deviceTokensMigration from "@/db/migrations/0015-device-push-tokens.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import type { Database } from "@/db/types/index.js";

async function freshDb() {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db as Kysely<any>);
  await deviceTokensMigration.up(db as Kysely<any>);
  return db;
}

describe("DeviceTokensRepository", () => {
  it("upsertForUser moves ownership when another user enrolls the same token", async () => {
    const db = await freshDb();
    const repo = new DeviceTokensRepository(db);
    await repo.upsertForUser("u1", "ExponentPushToken[aaa]", "ios");
    await repo.upsertForUser("u2", "ExponentPushToken[aaa]", "android");
    expect(await repo.listByUser("u1")).toEqual([]);
    const rows = await repo.listByUser("u2");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "u2", token: "ExponentPushToken[aaa]", platform: "android" });
    expect(rows[0].createdAt).toBe(rows[0].updatedAt); // fresh insert, not a merge
    await db.destroy();
  });

  it("keeps distinct tokens of the same user side by side", async () => {
    const db = await freshDb();
    const repo = new DeviceTokensRepository(db);
    await repo.upsertForUser("u1", "ExponentPushToken[one]", "ios");
    await repo.upsertForUser("u1", "ExponentPushToken[two]", "ios");
    expect((await repo.listByUser("u1")).map((r) => r.token).sort()).toEqual([
      "ExponentPushToken[one]",
      "ExponentPushToken[two]",
    ]);
    await db.destroy();
  });

  it("deleteForUser is scoped; deleteByToken is not; both are idempotent", async () => {
    const db = await freshDb();
    const repo = new DeviceTokensRepository(db);
    await repo.upsertForUser("u1", "ExponentPushToken[aaa]", "ios");
    await repo.deleteForUser("u2", "ExponentPushToken[aaa]"); // wrong owner: no-op
    expect(await repo.listByUser("u1")).toHaveLength(1);
    await repo.deleteForUser("u1", "ExponentPushToken[aaa]");
    await repo.deleteForUser("u1", "ExponentPushToken[aaa]"); // second call must not throw
    expect(await repo.listByUser("u1")).toHaveLength(0);
    await repo.deleteByToken("ExponentPushToken[nope]"); // unknown token: no-op
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/backend && bun test src/db/repositories/__tests__/device-tokens.repository.test.ts`
Expected: FAIL — cannot resolve `device-tokens.repository.js`.

- [ ] **Step 3: Write the repository**

Create `apps/backend/src/db/repositories/device-tokens.repository.ts`:

```ts
import type { Kysely } from "kysely";
import type { Database } from "@/db/types/index.js";
import type { DevicePlatform, DeviceTokenTable } from "@/db/types/device-tokens.db-types.js";

/**
 * One row per enrolled native device. `token` is globally unique — a
 * re-enrolling device (even under another user) replaces the row, because the
 * token IS the device's mailbox: only its current holder can be written to
 * it. Mirrors `NotificationsRepository`; see there for the full rationale.
 */
export class DeviceTokensRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Transactional delete-then-insert (same as `NotificationsRepository.upsertForUser`):
   * ownership may legitimately change (OS restore, reinstall → new sign-in),
   * and the transaction closes the window so a concurrent send sees either
   * the old row or the new one, never nothing.
   */
  async upsertForUser(userId: string, token: string, platform: DevicePlatform): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("deviceTokens").where("token", "=", token).execute();
      await tx
        .insertInto("deviceTokens")
        .values({ id: crypto.randomUUID(), userId, token, platform, createdAt: now, updatedAt: now })
        .execute();
    });
  }

  async listByUser(userId: string): Promise<DeviceTokenTable[]> {
    return this.db.selectFrom("deviceTokens").selectAll().where("userId", "=", userId).execute();
  }

  /** Scoped removal (user-initiated deregistration) — silently no-ops for another owner's token. */
  async deleteForUser(userId: string, token: string): Promise<void> {
    await this.db.deleteFrom("deviceTokens").where("userId", "=", userId).where("token", "=", token).execute();
  }

  /** Unscoped removal (send-time pruning: the relay said this token is dead). */
  async deleteByToken(token: string): Promise<void> {
    await this.db.deleteFrom("deviceTokens").where("token", "=", token).execute();
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**, then root verification, then commit:

```bash
cd apps/backend && bun test src/db/repositories/__tests__/device-tokens.repository.test.ts
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/db/repositories/device-tokens.repository.ts \
        apps/backend/src/db/repositories/__tests__/device-tokens.repository.test.ts
git commit -m "feat(backend): DeviceTokensRepository mirroring the web-push subscriptions repo"
```

---

### Task 3: `devices` route (cookie-only enrollment)

**Files:**
- Create: `apps/backend/src/api/devices.route.ts`
- Create: `apps/backend/src/api/__tests__/devices-route.test.ts`
- Modify: `apps/backend/src/api/auth-guard.ts` (add exported `requireCookieActor`)
- Modify: `apps/backend/src/api/notifications.route.ts` (drop local `browserOnly`, import the shared one — message strings must stay byte-identical)
- Modify: `apps/backend/src/api/routes.ts` (mount)
- Modify: `apps/mobile/src/lib/api.ts` (add `enrollDevice`/`forgetDevice`; refresh the stale `summary()` note — the route exists after Task 4)
- Test: `apps/mobile/src/lib/__tests__/api.test.ts` (extend)

**Interfaces:**
- Consumes: `DeviceTokensRepository` (Task 2), `authGuard`, `HttpError`, `apiModels`.
- Produces: `devicesRoutes` (Elysia instance, prefix `/api/devices`): `POST / {token, platform}` → `{ok:true}` upsert; `DELETE / {token}` → `{ok:true}` idempotent, owner-scoped. **No VAPID gate** (the Expo transport is independent of `vapid.json`). Exported from auth-guard: `requireCookieActor(actor: GuardActor, message: string): void`.

- [ ] **Step 1: Extract the cookie-only gate into auth-guard**

In `apps/backend/src/api/auth-guard.ts`, after `HttpError` is defined (so the class exists), add:

```ts
/**
 * Cookie-only gate: surfaces whose action is a human-in-the-browser/device
 * act — enabling browser push, enrolling a phone — reject machine
 * credentials outright. Extracted from `notifications.route.ts` so the
 * devices route mirrors it instead of forking the 403 shape.
 * @param actor - The request's authenticated actor kind
 * @param message - The full 403 message the surface wants on the wire
 * @throws HttpError 403 when the actor is not a browser session cookie
 */
export function requireCookieActor(actor: GuardActor, message: string): void {
  if (actor !== "cookie") throw new HttpError(403, message);
}
```

In `apps/backend/src/api/notifications.route.ts`: delete the local `browserOnly` function and its `GuardActor` type import, import `requireCookieActor` from `auth-guard.js`, and replace the three call sites with
`requireCookieActor(actor, "Notifications are restricted to browser sessions")` — the message text must stay byte-identical (invariant: existing tests pass unmodified; `notifications-route.test.ts` may assert the body).

- [ ] **Step 2: Write the failing route test**

Create `apps/backend/src/api/__tests__/devices-route.test.ts` (setup mirrors `notifications-route.test.ts`):

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { devicesRoutes } from "@/api/devices.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { __setVapidDirForTests } from "@/services/notify.service.js";

const app = new Elysia().use(errorHandlerPlugin).use(devicesRoutes);
const json = (b: unknown) => JSON.stringify(b);

describe("devices route", () => {
  const email = `devices-${crypto.randomUUID()}@mote.local`;
  const password = "devices-pass-1234";
  const otherEmail = `devices-other-${crypto.randomUUID()}@mote.local`;
  let cookie: string;
  let userId: string;
  let otherCookie: string;
  let otherUserId: string;
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables(); // runs the REAL migrations — device_tokens exists via the 0015 map entry
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(password), role: "user" });
    cookie = await signIn(email, password);
    otherUserId = await new UsersRepository(db).createUser({ email: otherEmail, passwordHash: await hashPassword(password), role: "user" });
    otherCookie = await signIn(otherEmail, password);
  });

  afterAll(async () => {
    for (const uid of [userId, otherUserId])
      await db.deleteFrom("deviceTokens").where("userId", "=", uid).execute();
    for (const kid of createdKeyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(otherEmail);
  });

  function req(path: string, init?: RequestInit, session?: string) {
    const headers = new Headers(init?.headers);
    if (session) headers.set("cookie", `better-auth.session_token=${session}`);
    return app.fetch(new Request(`http://localhost:3080/api/devices${path}`, { ...init, headers }));
  }
  const body = (token = "ExponentPushToken[TestToken0001]") =>
    json({ token, platform: "ios" });

  async function mintSystemKey(): Promise<string> {
    const created = (await auth.api.createApiKey({
      body: { name: "devices-test-system", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    return created.key;
  }

  it("POST enrolls a cookie actor's device and owns the row", async () => {
    const res = await req("/", { method: "POST", headers: { "content-type": "application/json" }, body: body() }, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await new DeviceTokensRepository(db).listByUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "ios", token: "ExponentPushToken[TestToken0001]" });
  });

  it("rejects a system bearer key with 403 and stores nothing", async () => {
    const key = await mintSystemKey();
    const res = await req("/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: body("ExponentPushToken[BearerNope0001]"),
    });
    expect(res.status).toBe(403);
    expect(await new DeviceTokensRepository(db).listByUser(userId)).toHaveLength(1); // unchanged
  });

  it("rejects anonymous with 401 and malformed bodies with 400", async () => {
    const anon = await req("/", { method: "POST", headers: { "content-type": "application/json" }, body: body("ExponentPushToken[AnonNope0001]") });
    expect(anon.status).toBe(401);
    const short = await req("/", { method: "POST", headers: { "content-type": "application/json" }, body: json({ token: "x", platform: "ios" }) }, cookie);
    expect(short.status).toBe(400);
    const plat = await req("/", { method: "POST", headers: { "content-type": "application/json" }, body: json({ token: "ExponentPushToken[OkOkOk0001]", platform: "symbian" }) }, cookie);
    expect(plat.status).toBe(400);
  });

  it("DELETE is owner-scoped and idempotent", async () => {
    await req("/", { method: "POST", headers: { "content-type": "application/json" }, body: body("ExponentPushToken[DelMe000001]") }, cookie);
    // the OTHER user must not be able to delete it:
    const wrong = await req("/", { method: "DELETE", headers: { "content-type": "application/json" }, body: json({ token: "ExponentPushToken[DelMe000001]" }) }, otherCookie);
    expect(wrong.status).toBe(200);
    expect(await new DeviceTokensRepository(db).listByUser(userId)).toHaveLength(2);
    const mine = await req("/", { method: "DELETE", headers: { "content-type": "application/json" }, body: json({ token: "ExponentPushToken[DelMe000001]" }) }, cookie);
    expect(mine.status).toBe(200);
    const again = await req("/", { method: "DELETE", headers: { "content-type": "application/json" }, body: json({ token: "ExponentPushToken[DelMe000001]" }) }, cookie);
    expect(again.status).toBe(200); // idempotent
    expect(await new DeviceTokensRepository(db).listByUser(userId)).toHaveLength(1);
  });

  it("enrolls even when VAPID is unconfigured — the Expo transport is independent", async () => {
    __setVapidDirForTests("/proc/mote-definitely-not-writable");
    try {
      const res = await req("/", { method: "POST", headers: { "content-type": "application/json" }, body: body("ExponentPushToken[NoVapid001]") }, cookie);
      expect(res.status).toBe(200);
    } finally {
      __setVapidDirForTests(null);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/backend && bun test src/api/__tests__/devices-route.test.ts`
Expected: FAIL — cannot resolve `devices.route.js`.

- [ ] **Step 4: Write the route**

Create `apps/backend/src/api/devices.route.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import { apiModels } from "@/schema/index.js";

/**
 * Native-device push enrollment (spec 2026-08-31-mobile-native-app §Backend
 * diff). Cookie-only like `notifications.route.ts`: enrolling a phone is a
 * human-in-the-device act, so machine credentials get 403. Deliberately NOT
 * gated on VAPID — the Expo transport is independent, and an instance with a
 * broken `vapid.json` must still be able to reach phones.
 */

const EnrollBodySchema = t.Object({
  token: t.String({
    minLength: 10,
    maxLength: 256,
    description: "Expo push token (ExponentPushToken[...])",
  }),
  platform: t.Union([t.Literal("ios"), t.Literal("android")], {
    description: "OS the token was minted on",
  }),
});

const ForgetBodySchema = t.Object({
  token: t.String({ minLength: 10, maxLength: 256, description: "Token to forget" }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

export const devicesRoutes = new Elysia({ prefix: "/api/devices" })
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, "Device enrollment is restricted to browser sessions");
      await new DeviceTokensRepository(db).upsertForUser(user.id, body.token, body.platform);
      return { ok: true } as const;
    },
    {
      body: EnrollBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "enrollDevice",
        tags: ["devices"],
        description: "Store this device's Expo push token (session cookies only)",
      },
    },
  )
  .delete(
    "/",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, "Device enrollment is restricted to browser sessions");
      // Owner-scoped and idempotent: sign-out deregistration must succeed even
      // if the row is already gone (pruned by a DeviceNotRegistered ticket).
      await new DeviceTokensRepository(db).deleteForUser(user.id, body.token);
      return { ok: true } as const;
    },
    {
      body: ForgetBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "forgetDevice",
        tags: ["devices"],
        description: "Forget a device token (session cookies only, idempotent)",
      },
    },
  );
```

Mount it in `apps/backend/src/api/routes.ts` after `notificationsRoutes`:

```ts
import { devicesRoutes } from "@/api/devices.route.js";
// …
.use(notificationsRoutes)
.use(devicesRoutes)
```

- [ ] **Step 5: Run the route test — expect PASS**, plus the notifications suite (the extraction must not move its 403 message):

```bash
cd apps/backend && bun test src/api/__tests__/devices-route.test.ts src/api/__tests__/notifications-route.test.ts
```

- [ ] **Step 6: Extend `MoteClient` (mobile) with device enrollment**

In `apps/mobile/src/lib/api.ts`, after `summary()`, add:

```ts
/**
 * Enrolls this phone for native push (cookie-only route). Called on every
 * cold start and after sign-in so token rotation stays bounded.
 * @param token - `ExpoPushTokenString` from expo-notifications
 * @param platform - `"ios" | "android"` as reported by the OS
 */
enrollDevice(token: string, platform: "ios" | "android"): Promise<{ ok: boolean }> {
  return this.request("/api/devices", { method: "POST", body: JSON.stringify({ token, platform }) });
}

/**
 * Idempotent removal of a device token — sign-out deregistration, so a
 * signed-out phone stops ringing.
 * @param token - The token previously enrolled
 */
forgetDevice(token: string): Promise<{ ok: boolean }> {
  return this.request("/api/devices", { method: "DELETE", body: JSON.stringify({ token }) });
}
```

And fix the now-stale NOTE on `summary()` (Task 4 makes the route real): replace its JSDoc body with
`/** Waiting/running counts for the tab badge (`GET /api/sessions/summary`). */`

In `apps/mobile/src/lib/__tests__/api.test.ts`, follow the file's existing fake-fetch pattern to add two cases: `enrollDevice` POSTs `{token, platform}` to `/api/devices`; `forgetDevice` DELETEs with `{token}` body. (Match the helper names the file already uses — do not invent a second harness.)

- [ ] **Step 7: Verification and commit**

```bash
cd /home/theo/projects/mote
bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/api/devices.route.ts apps/backend/src/api/__tests__/devices-route.test.ts \
        apps/backend/src/api/auth-guard.ts apps/backend/src/api/notifications.route.ts apps/backend/src/api/routes.ts \
        apps/mobile/src/lib/api.ts apps/mobile/src/lib/__tests__/api.test.ts
git commit -m "feat(backend): cookie-only /api/devices enrollment + MoteClient methods"
```

---

### Task 4: `GET /api/sessions/summary`

**Files:**
- Create: `apps/backend/src/api/sessions/summary-session.route.ts`
- Create: `apps/backend/src/api/sessions/__tests__/sessions-summary-route.test.ts`
- Modify: `apps/backend/src/db/repositories/sessions.repository.ts` (add `countsByUser`)
- Modify: `apps/backend/src/services/sessions.service.ts` (add `summarySessions`)
- Modify: `apps/backend/src/api/sessions/index.ts` (register **before** `getSessionRoute`)

**Interfaces:**
- Consumes: `contextPlugin`/`authGuard`/`requirePerm` (as `list-sessions.route.ts`), `sessions` rows (status/alive/waiting_since columns from 0014).
- Produces: `GET /api/sessions/summary → {total, running, waiting}`; `SessionsRepository.countsByUser(userId): Promise<{total, running, waiting}>`; `SessionsService.summarySessions(userId)` — Task 6 reuses `countsByUser` for the push badge.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/api/sessions/__tests__/sessions-summary-route.test.ts` (cookie pattern like `notifications-route.test.ts`, seeding via `SessionsRepository` like `sessions-notes-route.test.ts`):

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sessionRoutes } from "@/api/sessions/index.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * GET /api/sessions/summary — the badge source (spec §Backend diff).
 * Count arithmetic: waiting = running && alive && waiting_since IS NOT NULL.
 */
describe("GET /api/sessions/summary", () => {
  const email = `summary-${crypto.randomUUID()}@mote.local`;
  const pw = "summary-pass-1";
  let userId: string;
  let cookie: string;
  const created: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    cookie = await signIn(email, pw);
  });

  afterAll(async () => {
    for (const id of created) await db.deleteFrom("sessions").where("id", "=", id).execute();
    await deleteUserByEmailOrId(email);
  });

  async function seed(kind: "waiting" | "running" | "paused" | "terminated"): Promise<void> {
    const id = crypto.randomUUID();
    created.push(id);
    await new SessionsRepository(db).create({
      id, userId, profileId: "p", harnessId: "claude-code", name: `sum-${kind}`, workingDir: "/tmp", tmuxSocket: null,
    });
    const repo = new SessionsRepository(db);
    if (kind === "waiting") await repo.update(id, { waitingSince: new Date().toISOString() });
    if (kind === "paused") await repo.update(id, { alive: 0 });
    if (kind === "terminated") await repo.update(id, { status: "terminated", alive: 0 });
  }

  function get(path: string, session = cookie) {
    return sessionRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions${path}`, {
        headers: session ? { cookie: `better-auth.session_token=${session}` } : {},
      }),
    );
  }

  it("counts total/running/waiting across every state", async () => {
    await seed("waiting");
    await seed("waiting");
    await seed("running");
    await seed("paused"); // running but dead — counted in running? NO: alive=0
    await seed("terminated");
    const res = await get("/summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 5, running: 3, waiting: 2 });
  });

  it("anonymous is 401 and a foreign user sees only their own counts", async () => {
    const anon = await get("/summary", "");
    expect(anon.status).toBe(401);
    const otherEmail = `summary-other-${crypto.randomUUID()}@mote.local`;
    const otherId = await new UsersRepository(db).createUser({ email: otherEmail, passwordHash: await hashPassword(pw), role: "user" });
    const otherCookie = await signIn(otherEmail, pw);
    const res = await get("/summary", otherCookie);
    expect(await res.json()).toEqual({ total: 0, running: 0, waiting: 0 });
    await deleteUserByEmailOrId(otherEmail);
    await db.deleteFrom("sessions").where("userId", "=", otherId).execute();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/backend && bun test src/api/sessions/__tests__/sessions-summary-route.test.ts`
Expected: the counts test reaches `GET /:id` with `id="summary"` (404) — proving the route is unregistered.

- [ ] **Step 3: Add `countsByUser` to `SessionsRepository`**

Append to `apps/backend/src/db/repositories/sessions.repository.ts` (after `listByUser`):

```ts
/**
 * Badge/summary counts for one owner (spec §Backend diff). `waiting` is the
 * ratified formula: status='running' AND alive=1 AND waiting_since IS NOT
 * NULL. Plain row-scan, not SQL aggregates: per-user session lists are small
 * on a local instance (see security-context.md on pagination), and keeping
 * the predicate in one readable place beats three COUNT subqueries.
 * @param userId - Owner whose sessions are counted
 * @returns `{ total, running, waiting }` — running counts alive rows only
 */
async countsByUser(userId: string): Promise<{ total: number; running: number; waiting: number }> {
  const rows = await this.db
    .selectFrom("sessions")
    .select(["status", "alive", "waitingSince"])
    .where("userId", "=", userId)
    .execute();
  let running = 0;
  let waiting = 0;
  for (const r of rows) {
    const alive = r.status === "running" && r.alive === 1;
    if (alive) running += 1;
    if (alive && r.waitingSince != null) waiting += 1;
  }
  return { total: rows.length, running, waiting };
}
```

- [ ] **Step 4: Add the service method and route**

In `apps/backend/src/services/sessions.service.ts`, next to `listSessions` (~line 108), add:

```ts
/**
 * Waiting/running counts for the native app's tab badge and push payloads.
 * @param userId - Owner whose sessions are counted
 */
async summarySessions(userId: string): Promise<{ total: number; running: number; waiting: number }> {
  return await this.repos.sessions.countsByUser(userId);
}
```

Create `apps/backend/src/api/sessions/summary-session.route.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const SummaryResponseSchema = t.Object({
  total: t.Number({ description: "Sessions the user has ever had" }),
  running: t.Number({ description: "Sessions currently alive" }),
  waiting: t.Number({ description: "Alive sessions with waitingSince set — the badge number" }),
});

/**
 * `GET /api/sessions/summary` — badge counts in one cheap read (spec §Backend
 * diff). Registered before `/:id` in the sessions index: Elysia matches in
 * registration order, so this MUST win over the id route for "summary".
 */
export const summarySessionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/summary",
    async ({ user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "read");
      return await ctx.services.sessions.summarySessions(user.id);
    },
    {
      response: {
        200: SummaryResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSessionSummary",
        tags: ["sessions"],
        description: "Counts of the user's total/running/waiting sessions",
      },
    },
  );
```

Register in `apps/backend/src/api/sessions/index.ts` **between list and get**:

```ts
import { summarySessionRoute } from "@/api/sessions/summary-session.route.js";
// …
.use(listSessionsRoute)
.use(summarySessionRoute)
.use(getSessionRoute)
```

- [ ] **Step 5: Run tests — expect PASS** (both files pass while the ordering is right; if the counts test 404s, the registration order is wrong)

Run: `cd apps/backend && bun test src/api/sessions/__tests__/sessions-summary-route.test.ts`

- [ ] **Step 6: Verification and commit**

```bash
cd /home/theo/projects/mote
bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/api/sessions/summary-session.route.ts apps/backend/src/api/sessions/__tests__/sessions-summary-route.test.ts \
        apps/backend/src/api/sessions/index.ts apps/backend/src/db/repositories/sessions.repository.ts apps/backend/src/services/sessions.service.ts
git commit -m "feat(backend): GET /api/sessions/summary — badge counts for the native app"
```

---

### Task 5: `expo-push.ts` — message construction and the sender seam

**Files:**
- Create: `apps/backend/src/services/expo-push.ts`
- Create: `apps/backend/src/services/__tests__/expo-push.test.ts`
- Modify: `apps/backend/package.json` (+ `expo-server-sdk` "7.2.0" in dependencies)

**Interfaces:**
- Consumes: `APP_BASE_URL` (`@/constants.js`), `NotifyKind` (type-only import from `@/services/notify.service.js` — no runtime cycle; Task 6 makes the runtime edge point the other way).
- Produces: `ExpoPushMessage`, `ExpoPushSender = (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>`, `KIND_COPY`, `badgeCount(waiting: number, kind: NotifyKind, waitingSince: string | null): number`, `buildExpoMessages(tokens: readonly string[], sessionId: string, kind: NotifyKind, badge: number): ExpoPushMessage[]`, `looksLikeExpoToken(token: string): boolean`, `isUnregisteredTicket(ticket: ExpoPushTicket): boolean`, `chunk<T>(items: readonly T[], size?: number): T[][]`, `createExpoPushSender(): ExpoPushSender`. Task 6 imports all of these.

- [ ] **Step 1: Add the dependency**

```bash
cd apps/backend && bun add expo-server-sdk@7.2.0 && bunx syncpack fix && bun install
git -C /home/theo/projects/mote diff -- package.json apps/frontend/package.json apps/mobile/package.json bun.lock
```
Expected: only `apps/backend/package.json` + `bun.lock` changed (pinned exact `7.2.0`, no `^`). If syncpack touched another app, `git checkout` that file.

- [ ] **Step 2: Write the failing test**

Create `apps/backend/src/services/__tests__/expo-push.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { ExpoPushTicket } from "expo-server-sdk";
import {
  badgeCount,
  buildExpoMessages,
  chunk,
  isUnregisteredTicket,
  looksLikeExpoToken,
} from "@/services/expo-push.js";

describe("badgeCount", () => {
  it("adds 1 only for the watcher-order race (event will stamp, row not stamped yet)", () => {
    // recordAttention stamps BEFORE notifying: the row already carries the stamp.
    expect(badgeCount(2, "turn_complete", "2026-08-31T00:00:00.000Z")).toBe(2);
    // notify-idle notifies BEFORE stamping: this row is not in `waiting` yet.
    expect(badgeCount(2, "turn_complete", null)).toBe(3);
    expect(badgeCount(2, "needs_attention", null)).toBe(3);
    // non-waiting kinds never bump.
    expect(badgeCount(2, "exited", null)).toBe(2);
    expect(badgeCount(2, "crashed", null)).toBe(2);
    expect(badgeCount(0, "turn_complete", null)).toBe(1);
  });
});

describe("buildExpoMessages", () => {
  it("builds one opaque message per token — never a name, path or operator text", () => {
    const msgs = buildExpoMessages(["ExponentPushToken[a]", "ExponentPushToken[b"], "sess-1", "needs_attention", 4);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({
      to: "ExponentPushToken[a]",
      title: "mote",
      body: "A session needs you",
      badge: 4,
      sound: "default",
      threadId: "sess-1",
      data: { sid: "sess-1", kind: "needs_attention", origin: expect.any(String) },
    });
    const wire = JSON.stringify(msgs);
    expect(wire).not.toContain("resume-verify"); // no session name is ever passed in, so none can leak
    expect(wire).not.toContain("/home/");
    for (const kind of ["turn_complete", "needs_attention", "exited", "crashed", "crashed_final"] as const) {
      const [m] = buildExpoMessages(["t"], "s", kind, 0);
      expect(m!.body.length).toBeGreaterThan(0);
      expect(m!.title).toBe("mote"); // constant title, never the session name
    }
  });
});

describe("looksLikeExpoToken", () => {
  it("accepts the real shape and rejects junk rows", () => {
    expect(looksLikeExpoToken("ExponentPushToken[DnX1q2-abc_DEF987]")).toBe(true);
    expect(looksLikeExpoToken("https://push.example/x")).toBe(false);
    expect(looksLikeExpoToken("ExponentPushToken[]")).toBe(false);
    expect(looksLikeExpoToken("")).toBe(false);
  });
});

describe("isUnregisteredTicket", () => {
  it("flags ONLY DeviceNotRegistered as a prune signal", () => {
    const err = (error: string): ExpoPushTicket =>
      ({ status: "error", message: "boom", details: { error } }) as unknown as ExpoPushTicket;
    expect(isUnregisteredTicket(err("DeviceNotRegistered"))).toBe(true);
    expect(isUnregisteredTicket(err("MessageTitleTooLong"))).toBe(false); // our bug → keep the row
    expect(isUnregisteredTicket({ status: "ok", id: "t" } as ExpoPushTicket)).toBe(false);
    expect(isUnregisteredTicket({ status: "error", message: "no details" } as unknown as ExpoPushTicket)).toBe(false);
  });
});

describe("chunk", () => {
  it("splits at 100 by default and keeps order", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const parts = chunk(items);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(parts.flat()).toEqual(items);
    expect(chunk([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/backend && bun test src/services/__tests__/expo-push.test.ts`

- [ ] **Step 4: Write the module**

Create `apps/backend/src/services/expo-push.ts`:

```ts
import { Expo, type ExpoPushMessage as SdkPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { APP_BASE_URL } from "@/constants.js";
import type { NotifyKind } from "@/services/notify.service.js";

/**
 * Native push over the Expo relay (spec 2026-08-31-mobile-native-app §Push).
 *
 * PRIVACY CONTRACT (spec invariant 6) — nothing crossing exp.host may name
 * anything: `to` is the device token, `title` is the constant "mote", `body`
 * comes from KIND_COPY, plus an integer badge, the session UUID and the
 * kind. A session name, working directory, note or operator text in a
 * constructed message is a spec violation, caught by test.
 */

/** One native push message as this service builds and sends it. */
export interface ExpoPushMessage {
  /** Single device token (batching happens in `chunk`, never via to[]) */
  to: string;
  /** Constant app name — never the session name (privacy contract). */
  title: string;
  /** Generic copy for the kind — the only human-readable text. */
  body: string;
  /** App-icon badge: this user's waiting count at send time. */
  badge: number;
  sound: "default";
  /** Session id — replaces the session's earlier notification, like web's `tag`. */
  threadId: string;
  /** Opaque routing data; `sid` is a uuid, `origin` lets the app pick the instance. */
  data: { sid: string; kind: NotifyKind; origin: string };
}

/**
 * Generic lock-screen copy. "needs you" vs "crashed" is the difference
 * between a glance and a sprint — and it names nothing.
 */
const KIND_COPY: Record<NotifyKind, string> = {
  turn_complete: "A session needs you",
  needs_attention: "A session needs you",
  exited: "A session exited",
  crashed: "A session crashed — auto-restarting",
  crashed_final: "A session crashed",
};

/**
 * Badge number at send time: the owner's waiting count, plus 1 when THIS
 * event will put the session into waiting but the row is not stamped yet.
 * The two call paths stamp in opposite orders — `recordAttention` stamps
 * BEFORE notifying (`sessions.service.ts`), the idle watcher notifies THEN
 * stamps (`notify-idle.ts`) — so without the +1 a watcher-fired push badges
 * one short. Deliberate; unit-pinned; do not "simplify".
 */
export function badgeCount(waiting: number, kind: NotifyKind, waitingSince: string | null): number {
  const makesWait = (kind === "turn_complete" || kind === "needs_attention") && waitingSince === null;
  return waiting + (makesWait ? 1 : 0);
}

/** Real Expo token shape; junk rows are pruned rather than sent to. */
const TOKEN_RE = /^ExponentPushToken\[[A-Za-z0-9_-]{1,128}\]$/;

export function looksLikeExpoToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Builds one message per token. Receives ids and counts, never names. */
export function buildExpoMessages(
  tokens: readonly string[],
  sessionId: string,
  kind: NotifyKind,
  badge: number,
): ExpoPushMessage[] {
  return tokens.map((to) => ({
    to,
    title: "mote",
    body: KIND_COPY[kind],
    badge,
    sound: "default" as const,
    threadId: sessionId,
    data: { sid: sessionId, kind, origin: APP_BASE_URL },
  }));
}

/** True when the relay says the device is gone for good → prune the row. */
export function isUnregisteredTicket(ticket: ExpoPushTicket): boolean {
  return (
    ticket.status === "error" &&
    (ticket as { details?: { error?: string } }).details?.error === "DeviceNotRegistered"
  );
}

/** Batches at `size` (Expo's own documented limit is 100 per request). */
export function chunk<T>(items: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Function seam over the Expo push API so tests inject a fake (the sibling
 * of `PushSender` in notify.service). CONTRACT: returns one ticket per
 * message, in order — `notifySession` zips tickets against messages by
 * index to prune DeviceNotRegistered rows. A transport exception (thrown)
 * is transient: every row survives.
 */
export type ExpoPushSender = (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;

let client: Expo | null = null;

/** Lazy singleton — constructed on the first real send, never in tests. */
function expoClient(): Expo {
  // EXPO_PUSH_ACCESS_TOKEN when proof-of-ownership is enforced; anonymous
  // sends to exp.host are rate-limited (spec §Infra prerequisites).
  client ??= new Expo({ accessToken: process.env.EXPO_PUSH_ACCESS_TOKEN || undefined });
  return client;
}

/** The production sender: chunk at 100, concatenate tickets in order. */
export function createExpoPushSender(): ExpoPushSender {
  return async (messages) => {
    const tickets: ExpoPushTicket[] = [];
    for (const part of chunk(messages)) {
      const res = await expoClient().sendPushNotificationsAsync(part as SdkPushMessage[]);
      tickets.push(...res);
    }
    return tickets;
  };
}
```

If `sendPushNotificationsAsync` rejects the structural cast (its `sound` union), cast the chunk `as unknown as SdkPushMessage[]` and keep our narrow type as the source of truth.

- [ ] **Step 5: Run tests — expect PASS**, verification, commit:

```bash
cd apps/backend && bun test src/services/__tests__/expo-push.test.ts
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/services/expo-push.ts apps/backend/src/services/__tests__/expo-push.test.ts apps/backend/package.json bun.lock
git commit -m "feat(backend): expo-push module — opaque messages, badge math, sender seam"
```

---

### Task 6: `notifySession` device fan-out

**Files:**
- Modify: `apps/backend/src/services/notify.service.ts`
- Create: `apps/backend/src/services/__tests__/notify-device.test.ts`

**Interfaces:**
- Consumes: `DeviceTokensRepository` (Task 2), `SessionsRepository.countsByUser` (Task 4), everything from Task 5.
- Produces: `createNotifyService` gains optional deps `{ devices?: DeviceTokensRepository; expoSender?: ExpoPushSender }` and an internal `__setExpoSenderForTests(sender | null)` export; `getNotifyService()` wires the real repo + production sender. **Existing export names and behaviour are unchanged** — `notify.service.test.ts` must still pass untouched (invariant 2).

- [ ] **Step 1: Write the failing device-path test**

Create `apps/backend/src/services/__tests__/notify-device.test.ts`. It runs on the **shared per-process test DB** via `setupAuthTables()` (which executes the real migration chain including 0015) rather than the scratch `freshDb()` of `notify.service.test.ts` — that scratch schema (0001 + 0014) lacks the `alive` column added by 0003, which `countsByUser` reads. Rows are isolated by a per-suite random `userId`, cleaned up in `afterAll` (the shared DB is never assumed empty).

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ExpoPushTicket } from "expo-server-sdk";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { createNotifyService, type PushSender } from "@/services/notify.service.js";
import type { ExpoPushMessage } from "@/services/expo-push.js";

const uid = crypto.randomUUID();
const userId = `device-user-${uid}`;
const sessionIds: string[] = [];
const tokens: string[] = [];

async function seedSession(id: string, opts: { notify?: boolean; waitingSince?: string | null; alive?: number; status?: "running" | "terminated" } = {}) {
  sessionIds.push(id);
  await new SessionsRepository(db).create({
    id, userId, profileId: "p", harnessId: "h", name: "resume-verify", workingDir: "/tmp/private/work", tmuxSocket: null,
  });
  await db
    .updateTable("sessions")
    .set({ notify: opts.notify ? 1 : 0, waitingSince: opts.waitingSince ?? null, alive: opts.alive ?? 1, status: opts.status ?? "running" })
    .where("id", "=", id)
    .execute();
}

async function enroll(token: string) {
  tokens.push(token);
  await new DeviceTokensRepository(db).upsertForUser(userId, token, "ios");
}

const okTickets = (n: number): ExpoPushTicket[] =>
  Array.from({ length: n }, (_, i) => ({ status: "ok", id: `t${i}` }) as unknown as ExpoPushTicket);

const neverWeb: PushSender = async () => ({ statusCode: 201 });

function services(record: { calls: ExpoPushMessage[][] }, tickets?: ExpoPushTicket[] | "throw") {
  const devices = new DeviceTokensRepository(db);
  const svc = createNotifyService({
    sessions: db,
    subs: new NotificationsRepository(db),
    devices,
    sender: neverWeb,
    expoSender: async (msgs) => {
      record.calls.push(msgs);
      if (tickets === "throw") throw new Error("network down");
      return tickets ?? okTickets(msgs.length);
    },
    vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
  });
  return { svc, devices };
}

describe("notifySession — device fan-out", () => {
  beforeAll(async () => {
    await setupAuthTables(); // real migrations → device_tokens + alive exist
  });

  afterAll(async () => {
    for (const id of sessionIds) await db.deleteFrom("sessions").where("id", "=", id).execute();
    for (const t of tokens) await db.deleteFrom("deviceTokens").where("token", "=", t).execute();
    await db.deleteFrom("notificationsSubscriptions").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(userId); // no user row was created; harmless no-op keeps cleanup uniform
  });

  it("stays silent unless the bell is on", async () => {
    await seedSession(`${uid}-off`, { notify: false });
    await enroll(`ExponentPushToken[off${uid.slice(0, 8)}]`);
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc } = services(rec);
    await svc.notifySession(`${uid}-off`, "turn_complete");
    expect(rec.calls).toHaveLength(0);
  });

  it("rings devices even when the user has NO web subscriptions", async () => {
    // Regression pin for the old `if (subs.length === 0) return` early-exit:
    // the device fan-out must be independent of web-sub presence.
    await seedSession(`${uid}-nosubs`, { notify: true });
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc } = services(rec);
    await svc.notifySession(`${uid}-nosubs`, "turn_complete");
    expect(rec.calls.length).toBeGreaterThanOrEqual(1);
    const mine = rec.calls.flatMap((c) => c).find((m) => m.threadId === `${uid}-nosubs`);
    expect(mine).toMatchObject({ title: "mote", threadId: `${uid}-nosubs`, data: { sid: `${uid}-nosubs`, kind: "turn_complete" } });
  });

  it("never carries a name, path or operator text to the relay", async () => {
    await seedSession(`${uid}-privacy`, { notify: true });
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc } = services(rec);
    await svc.notifySession(`${uid}-privacy`, "turn_complete");
    const wire = JSON.stringify(rec.calls);
    expect(wire).not.toContain("resume-verify");
    expect(wire).not.toContain("/tmp/private/work");
  });

  it("prunes DeviceNotRegistered tickets; keeps other errors and transient throws", async () => {
    await seedSession(`${uid}-prune`, { notify: true });
    const deadTok = `ExponentPushToken[dead${uid.slice(0, 8)}]`;
    const oursTok = `ExponentPushToken[ours${uid.slice(0, 8)}]`;
    await enroll(deadTok);
    await enroll(oursTok);
    const dead = (msg: string): ExpoPushTicket =>
      ({ status: "error", message: msg, details: { error: msg } }) as unknown as ExpoPushTicket;
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc, devices } = services(rec, [dead("DeviceNotRegistered"), dead("MessageTitleTooLong")]);
    await svc.notifySession(`${uid}-prune`, "turn_complete");
    const left = (await devices.listByUser(userId)).map((r) => r.token);
    expect(left).toEqual([oursTok]); // our-bug ticket keeps the row

    await seedSession(`${uid}-throw`, { notify: true });
    const keepTok = `ExponentPushToken[keep${uid.slice(0, 8)}]`;
    await enroll(keepTok);
    const rec2 = { calls: [] as ExpoPushMessage[][] };
    const s2 = services(rec2, "throw");
    await s2.svc.notifySession(`${uid}-throw`, "turn_complete");
    const stillLeft = (await s2.devices.listByUser(userId)).map((r) => r.token);
    expect(stillLeft).toContain(keepTok); // transport exception = transient: rows survive
    expect(stillLeft).toContain(oursTok);
  });

  it("prunes junk-token rows and sends only to real ones", async () => {
    await seedSession(`${uid}-junk`, { notify: true });
    const junkTok = `https://junk.example/${uid}`;
    const realTok = `ExponentPushToken[real${uid.slice(0, 8)}]`;
    await db
      .insertInto("deviceTokens")
      .values({ id: crypto.randomUUID(), userId, token: junkTok, platform: "ios", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .execute();
    await enroll(realTok);
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc, devices } = services(rec);
    await svc.notifySession(`${uid}-junk`, "turn_complete");
    const sent = rec.calls.flatMap((c) => c).filter((m) => m.data.sid === `${uid}-junk`).map((m) => m.to);
    expect(sent).toContain(realTok);
    expect(sent).not.toContain(junkTok);
    expect((await devices.listByUser(userId)).map((r) => r.token)).not.toContain(junkTok);
  });

  it("badges the watcher-order +1, then settles once the stamp lands", async () => {
    const subject = `${uid}-badge`;
    await seedSession(subject, { notify: true, waitingSince: null }); // not stamped yet (watcher order)
    await seedSession(`${uid}-w1`, { notify: true, waitingSince: "2026-08-31T00:00:00.000Z" });
    await seedSession(`${uid}-w2`, { notify: true, waitingSince: "2026-08-31T00:00:00.000Z" });
    await seedSession(`${uid}-dead`, { notify: true, waitingSince: null, alive: 0 }); // never counted
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc } = services(rec);
    await svc.notifySession(subject, "turn_complete");
    const first = rec.calls.flatMap((c) => c).find((m) => m.data.sid === subject);
    expect(first?.badge).toBe(3); // 2 waiting + this one about to stamp
    await db.updateTable("sessions").set({ waitingSince: "2026-08-31T00:00:01.000Z" }).where("id", "=", subject).execute();
    await svc.notifySession(subject, "needs_attention");
    const second = rec.calls.flatMap((c) => c).filter((m) => m.data.sid === subject).at(-1);
    expect(second?.badge).toBe(3); // stamped: already inside the count
  });

  it("a service built WITHOUT the device transport never touches it (legacy pin)", async () => {
    await seedSession(`${uid}-legacy`, { notify: true });
    const hits: { to: string[] } = { to: [] };
    let expoCalled = false;
    const svc = createNotifyService({
      sessions: db,
      subs: new NotificationsRepository(db),
      sender: async (sub) => {
        hits.to.push(sub.endpoint);
        return { statusCode: 201 };
      },
      expoSender: async () => {
        expoCalled = true;
        return okTickets(1);
      },
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
      // devices: intentionally absent — the pre-mobile shape (notify.service.test.ts's shape).
    });
    await new NotificationsRepository(db).upsertForUser(userId, `https://push/legacy-${uid}`, "k", "a");
    const legacyWeb = hits.to.length;
    await svc.notifySession(`${uid}-legacy`, "turn_complete");
    expect(hits.to.length).toBe(legacyWeb + 1);
    expect(expoCalled).toBe(false); // no repo → no fan-out even with a sender present
  });
});
```

Note the isolation rule: every assertion against `listByUser`/`rec.calls` is scoped to `userId` (fresh per process) or the session's `data.sid` — other suites may write rows to the same tables concurrently-in-process, never assume an empty DB.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/backend && bun test src/services/__tests__/notify-device.test.ts`
Expected: FAIL — `NotifyServiceDeps` has no `devices`/`expoSender`.

- [ ] **Step 3: Extend `notify.service.ts`**

Imports to add: `DeviceTokensRepository`, `SessionTable` (type), and from `expo-push.js`: `badgeCount`, `buildExpoMessages`, `createExpoPushSender`, `isUnregisteredTicket`, `looksLikeExpoToken`, `type ExpoPushMessage`, `type ExpoPushSender`. Add to `NotifyServiceDeps` (both optional so `notify.service.test.ts` compiles untouched):

```ts
  /** Native-device transport; absent = pre-mobile behaviour (invariant 2). */
  devices?: DeviceTokensRepository;
  expoSender?: ExpoPushSender;
```

Module-level test seam beside `senderOverride`:

```ts
let expoSenderOverride: ExpoPushSender | null = null;

/**
 * @internal Test isolation: route device fan-out through `sender` instead of
 * the real Expo client. Resets the singleton like `__setSenderForTests`.
 */
export function __setExpoSenderForTests(sender: ExpoPushSender | null): void {
  expoSenderOverride = sender;
  singleton = null;
}
```

Inside `createNotifyService`:

```ts
const expoSend: ExpoPushSender = deps.expoSender ?? expoSenderOverride ?? createExpoPushSender();
```

Rewrite `notifySession` to run both fan-outs under the one bell gate (the web loop body stays byte-identical to today — invariant 2):

```ts
    async notifySession(sessionId: string, kind: NotifyKind): Promise<void> {
      try {
        const row = await new SessionsRepository(deps.sessions).findById(sessionId);
        if (row?.notify !== 1) return;
        // The bell gate above is the SINGLE policy point for BOTH transports
        // (spec §Push): flipping a bell changes web and native identically on
        // the next event — send-time, nothing to invalidate.
        const subs = await deps.subs.listByUser(row.userId);
        if (subs.length > 0) {
          const payload = JSON.stringify(buildNotificationPayload(row, kind));
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
        }
        await notifyDevices(row, kind);
      } catch (err) {
        // Notifications must never break the caller (sweep / hook route).
        logger.withError(err).warn(`notifySession(${sessionId}, ${kind}) failed`);
      }
    },
```

And the new private function inside the closure (after `notifySession`):

```ts
    /** Device fan-out (spec §Push): opaque messages, ticket-pruned rows. */
    async function notifyDevices(row: SessionTable, kind: NotifyKind): Promise<void> {
      if (!deps.devices) return; // pre-mobile shape — nothing to do (invariant 2)
      const tokens = await deps.devices.listByUser(row.userId);
      if (tokens.length === 0) return;
      const live = tokens.filter((t) => looksLikeExpoToken(t.token));
      for (const junk of tokens) {
        if (!live.includes(junk)) {
          await deps.devices.deleteByToken(junk.token); // a row the relay can never use
          logger.warn(`pruned invalid device token for user ${junk.userId}`);
        }
      }
      if (live.length === 0) return;
      const counts = await new SessionsRepository(deps.sessions).countsByUser(row.userId);
      const badge = badgeCount(counts.waiting, kind, row.waitingSince);
      const messages = buildExpoMessages(live.map((t) => t.token), row.id, kind, badge);
      try {
        const tickets = await expoSend(messages);
        // Tickets zip 1:1 with messages, in order (ExpoPushSender contract).
        for (let i = 0; i < tickets.length; i += 1) {
          const ticket = tickets[i];
          const token = messages[i]?.to;
          if (!ticket || !token) continue;
          if (isUnregisteredTicket(ticket)) {
            await deps.devices.deleteByToken(token); // the relay says the device is gone
          } else if (ticket.status === "error") {
            logger.warn(`expo push ticket error (kept): ${ticket.message}`); // e.g. MessageTitleTooLong = our bug
          }
        }
      } catch (err) {
        // Transport exception is transient BY CONTRACT: every row survives.
        logger.withError(err).warn(`expo push send failed (kept) for ${live.length} device(s)`);
      }
    }
```

Update the singleton wiring and note the `row?.waitingSince` type: `SessionTable.waitingSince` is `string | null` — matches `badgeCount`.

```ts
export function getNotifyService(): NotifyService {
  singleton ??= createNotifyService({
    sessions: db,
    subs: new NotificationsRepository(db),
    devices: new DeviceTokensRepository(db),
  });
  return singleton;
}
```

(No `expoSender` passed: the production sender comes from the `createExpoPushSender()` fallback, which lets `__setExpoSenderForTests` work like the web sender override.)

- [ ] **Step 4: Run BOTH notify suites — device passes, legacy untouched**

```bash
cd apps/backend && bun test src/services/__tests__/notify-device.test.ts src/services/__tests__/notify.service.test.ts
```
Expected: all pass. `notify.service.test.ts` must be unmodified in `git diff` — verify: `git status` must not list it.

- [ ] **Step 5: Full verification and commit**

```bash
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/services/notify.service.ts apps/backend/src/services/__tests__/notify-device.test.ts
git commit -m "feat(backend): notifySession fans out to Expo devices behind the same bell"
```

---

### Task 7: Integration verification (build graph + live harness)

**Files:**
- No source changes; expected artefacts only.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Rebuild the client surface**

Backend routes changed, so `@internal/backend-client` (Treaty types) must see them (`.claude/rules/build.md`):

```bash
cd /home/theo/projects/mote && turbo build
```
Expected: every package builds; no tsc errors.

- [ ] **Step 2: Run the M1 transport harness against a live instance** (optional but cheap when one is up; it exercises the same cookie path the devices route needs):

```bash
cd apps/mobile && bun run harness:m1
```
Expected: the checks the script already prints; the new endpoints are NOT required by it — this step just proves no regression in the transport contract.

- [ ] **Step 3: Confirm the invariants with grep, and record them in the commit-less checklist**

```bash
git diff main@{0} HEAD --name-only | sort
# must NOT include: apps/backend/src/services/__tests__/notify.service.test.ts,
#                   apps/backend/src/api/ws-token.route.ts, apps/backend/src/ws/
grep -rn "row.name\|workingDir" apps/backend/src/services/expo-push.ts  # must be empty
```
Expected: the three files absent; the grep empty. If any check fails, fix before continuing — do not amend history silently.

- [ ] **Step 4: Update the mobile docs pointer**

In `apps/mobile/AGENTS.md` §Auth (or a new §Push bullet under "Non-obvious decisions"), add two lines documenting that enrollment calls `POST /api/devices` and that `api.summary()` now resolves (the stale note was fixed in Task 3):

```
**Push enrollment is cookie-only**: `POST /api/devices` with the Expo token — the
same actor rule as ws-token/notifications (`apps/backend/src/api/devices.route.ts`).
Sign-out must `forgetDevice` first so a signed-out phone stops ringing.
```

```bash
git add apps/mobile/AGENTS.md apps/mobile/CLAUDE.md
git commit -m "docs(mobile): push enrollment contract"
```
(Only add `apps/mobile/CLAUDE.md` if it duplicates the section.)

---

## Spec coverage map (self-review result)

| Spec requirement | Task |
| --- | --- |
| Migration `0015` in folder + static map | 1 |
| `DeviceTokensRepository` (upsertForUser/listByUser/delete) | 2 |
| `api/devices` POST/DELETE, cookie-only, no VAPID gate, `t` descriptions | 3 |
| `GET /api/sessions/summary` before `/:id` | 4 |
| `services/expo-push.ts` seam + `expo-server-sdk` 7.2.0 chunked at 100 | 5 |
| Bell gate as the single policy point; send-time | 6 |
| `DeviceNotRegistered` prunes; `MessageTitleTooLong`-class keeps; exception keeps; opaque payload; badge skew incl. watcher +1 | 5, 6 |
| Invariant 2 (legacy path pinned) | 6 (last test) + 7 (grep) |
| Migration/repository/route/service test bullets from §Testing | 1–6 |
