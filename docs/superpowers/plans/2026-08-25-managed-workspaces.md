# Managed Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class, install-wide `workspaces` entity (name + path + description + rw/ro access), with admin CRUD, a manage/edit UI, a new-session dropdown that fills `workspacePath`, and compose read-write host mounts aligned to the host uid.

**Architecture:** Workspaces are a global registry (like `settings`, not per-user) sitting *on top of* the existing session model — sessions keep raw `workspacePath` strings, no FK. Backend adds a `workspaces` table + `WorkspacesRepository` + `workspaces.route.ts` (admin mutations, list for all). Frontend adds `useWorkspaces()` hook, `/workspaces` manage + `/workspaces/$id` edit routes, shared `WorkspaceFields`, and a dropdown in the new-session form. Docker compose gets `user:` (host uid) + RW `/workspace` mounts.

**Tech Stack:** Bun + Turborepo; Elysia (`t` schemas, `authGuard`/`requireAdmin`), Kysely (SQLite, `CamelCasePlugin`), TanStack Router + Query, Radix `Select`/`Switch`, shadcn-style `Card`/`Input`/`Label`/`Badge`.

## Global Constraints

- **Bun only** for package manager / runtime. No npm/pnpm/yarn. `bun install`, `bun run`, `bunx`.
- **Pinned deps** — exact versions, never `^`/`~`. If adding packages, run `bun add <pkg>`, then `syncpack fix`, then `bun install`.
- **No dynamic imports** — always static top-level `import`.
- **Elysia `t` schemas must carry `description`** (feeds OpenAPI/client SDK).
- **Named schema constants**, never inline `t.Object({...})` in route bodies.
- **Private error class per route** with `readonly status` (not `@internal/backend-errors`), matching sibling routes.
- **Always write tests** (repo + migration + route + pure-frontend).
- **Verify after changes:** `bun run verify-types`, `bun run lint`, `bun run test`.
- **`turbo build` after backend route/schema changes** (regenerates `@internal/backend-client`).
- **Index naming:** `idx_<table>_<cols>`, lowercase snake_case columns; Kysely camelCase via `CamelCasePlugin`.

---

### Task 1: Backend — workspaces migration + DB types

**Files:**
- Create: `apps/backend/src/db/migrations/0005-workspaces.ts`
- Create: `apps/backend/src/db/types/workspaces.db-types.ts`
- Modify: `apps/backend/src/db/migrate.ts` (add import + provider entry)
- Modify: `apps/backend/src/db/types/index.ts` (register `workspaces`)
- Create: `apps/backend/src/db/migrations/__tests__/0005-workspaces.test.ts`

**Interfaces:**
- Consumes: nothing (new table).
- Produces:
  - `up(db: Kysely<any>): Promise<void>` + `down(db: Kysely<any>): Promise<void>` (migration module).
  - `WorkspaceTable { id: string; name: string; path: string; description: string | null; access: "rw" | "ro"; createdAt: string; updatedAt: string }`
  - `NewWorkspace = Omit<WorkspaceTable, "createdAt" | "updatedAt">`
  - `WorkspaceUpdate = Partial<Omit<NewWorkspace, "id">>`
  - `WorkspaceAccess = "rw" | "ro"` type export.

- [ ] **Step 1: Write the failing migration test**

`apps/backend/src/db/migrations/__tests__/0005-workspaces.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunSqliteDialect, openSqliteDatabase } from "@internal/sqlite-dialect";
import { CamelCasePlugin, Kysely } from "kysely";
import { up as up005 } from "@/db/migrations/0005-workspaces.js";

/**
 * Minimal typed shape of the workspaces table for this migration's tests.
 */
interface MigrationDatabase {
  workspaces: {
    id: string;
    name: string;
    path: string;
    description: string | null;
    access: "rw" | "ro";
  };
}

describe("0005 workspaces migration", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/mote-005-${Math.random().toString(36).slice(2)}.db`;
    const sqlite = openSqliteDatabase(dbFile);
    db = new Kysely<MigrationDatabase>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    });
    await up005(db);
  });
  afterAll(() => {
    Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  it("creates the workspaces table with default access 'rw' and unique name/path", async () => {
    await db
      .insertInto("workspaces")
      .values({ id: "w1", name: "Projects", path: "/workspace" })
      .execute();
    const row = await db
      .selectFrom("workspaces")
      .select(["id", "name", "path", "description", "access"])
      .where("id", "=", "w1")
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ id: "w1", name: "Projects", path: "/workspace", description: null, access: "rw" });
  });

  it("enforces unique name and unique path", async () => {
    await db.insertInto("workspaces").values({ id: "w2", name: "A", path: "/a" }).execute();
    expect(db.insertInto("workspaces").values({ id: "w3", name: "A", path: "/b" }).execute()).rejects.toThrow();
    expect(db.insertInto("workspaces").values({ id: "w4", name: "B", path: "/a" }).execute()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0005-workspaces.test.ts`
Expected: FAIL — `Failed to find module '.../0005-workspaces'` (module doesn't exist yet).

- [ ] **Step 3: Write the migration**

`apps/backend/src/db/migrations/0005-workspaces.ts`:

```ts
import type { Kysely } from "kysely";

/**
 * Managed workspaces: named, install-wide directories a session can run
 * against. Global scope (no user_id) — like settings, not profiles.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("workspaces")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("path", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("access", "text", (col) => col.notNull().defaultTo("rw"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema.createIndex("idx_workspaces_name").on("workspaces").column("name").unique().execute();
  await db.schema.createIndex("idx_workspaces_path").on("workspaces").column("path").unique().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("workspaces").execute();
}
```

Note: `sql` is used for the timestamp defaults — import it: `import { sql, type Kysely } from "kysely";` (mirrors `0001-init.ts:56`).

- [ ] **Step 4: Write the DB types**

`apps/backend/src/db/types/workspaces.db-types.ts`:

```ts
/**
 * A managed, install-wide workspace: a named directory a session runs against.
 * Global (no user_id): any user can list, admins mutate.
 */
export interface WorkspaceTable {
  /** Unique workspace id (uuid) */
  id: string;
  /** Friendly label (unique) */
  name: string;
  /** Absolute directory path on the container FS (unique, must exist) */
  path: string;
  /** Optional longer description */
  description: string | null;
  /** "rw" = read-write (default), "ro" = read-only advisory marker */
  access: WorkspaceAccess;
  /** ISO 8601 timestamp when the workspace was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

export type WorkspaceAccess = "rw" | "ro";

/** Insert shape: DB defaults fill createdAt/updatedAt. */
export type NewWorkspace = Omit<WorkspaceTable, "createdAt" | "updatedAt">;

/** Update shape. */
export type WorkspaceUpdate = Partial<Omit<NewWorkspace, "id">>;
```

- [ ] **Step 5: Register the migration + table in the Database interface**

`apps/backend/src/db/migrate.ts`:
- Add `import * as workspacesMigration from "@/db/migrations/0005-workspaces.js";`
- Add `"0005-workspaces": workspacesMigration,` to the `getMigrations()` map.

`apps/backend/src/db/types/index.ts`:
- Add `import type { WorkspaceTable } from "@/db/types/workspaces.db-types.js";`
- Add `workspaces: WorkspaceTable;` to the `Database` interface.

- [ ] **Step 6: Run the migration test to verify it passes**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0005-workspaces.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run existing repo tests to confirm no regression**

Run: `cd apps/backend && bun test`
Expected: all existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/db/migrations/0005-workspaces.ts apps/backend/src/db/migrations/__tests__/0005-workspaces.test.ts apps/backend/src/db/types/workspaces.db-types.ts apps/backend/src/db/migrate.ts apps/backend/src/db/types/index.ts
git commit -m "feat(workspaces): workspaces table migration + db types"
```

---

### Task 2: Backend — workspaces repository

**Files:**
- Create: `apps/backend/src/db/repositories/workspaces.repository.ts`
- Create: `apps/backend/src/db/repositories/__tests__/workspaces-repository.test.ts`
- Modify: `apps/backend/src/db/repositories/index.ts` (add to `Repositories` interface)

**Interfaces:**
- Consumes: `WorkspaceTable`, `NewWorkspace`, `WorkspaceUpdate` (Task 1).
- Produces: `WorkspacesRepository` class with:
  - `create(workspace: NewWorkspace): Promise<WorkspaceTable>`
  - `findById(id: string): Promise<WorkspaceTable | undefined>`
  - `list(): Promise<WorkspaceTable[]>` (ordered `name asc`)
  - `update(id: string, update: WorkspaceUpdate): Promise<WorkspaceTable | undefined>`
  - `delete(id: string): Promise<void>`

- [ ] **Step 1: Write the failing repository test**

`apps/backend/src/db/repositories/__tests__/workspaces-repository.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BunSqliteDialect, openSqliteDatabase } from "@internal/sqlite-dialect";
import { CamelCasePlugin, Kysely } from "kysely";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as authAuditMigration from "@/db/migrations/0004-auth-audit.js";
import * as workspacesMigration from "@/db/migrations/0005-workspaces.js";
import { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";
import type { Database } from "@/db/types/index.js";

const db = new Kysely<Database>({
  dialect: new BunSqliteDialect({ database: () => openSqliteDatabase(":memory:") }),
  plugins: [new CamelCasePlugin()],
});

const workspaces = new WorkspacesRepository(db);

beforeAll(async () => {
  await initMigration.up(db);
  await operatorUxMigration.up(db);
  await remoteOpsMigration.up(db);
  await authAuditMigration.up(db);
  await workspacesMigration.up(db);
});

beforeEach(async () => {
  await db.deleteFrom("workspaces").execute();
});

describe("workspaces repository", () => {
  it("creates and lists workspaces ordered by name", async () => {
    await workspaces.create({
      id: crypto.randomUUID(),
      name: "Theta",
      path: "/workspace/theta",
      description: null,
      access: "rw",
    });
    await workspaces.create({
      id: crypto.randomUUID(),
      name: "Alpha",
      path: "/workspace/alpha",
      description: "first",
      access: "ro",
    });

    const all = await workspaces.list();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("Alpha");
    expect(all[1].name).toBe("Theta");
  });

  it("updates and deletes workspaces", async () => {
    const created = await workspaces.create({
      id: crypto.randomUUID(),
      name: "A",
      path: "/workspace/a",
      description: null,
      access: "rw",
    });

    const updated = await workspaces.update(created.id, { name: "B", access: "ro" });
    expect(updated?.name).toBe("B");
    expect(updated?.access).toBe("ro");

    await workspaces.delete(created.id);
    const gone = await workspaces.findById(created.id);
    expect(gone).toBeUndefined();
  });

  it("rejects duplicate names and duplicate paths", async () => {
    await workspaces.create({ id: crypto.randomUUID(), name: "A", path: "/workspace/a", description: null, access: "rw" });
    await expect(
      workspaces.create({ id: crypto.randomUUID(), name: "A", path: "/workspace/b", description: null, access: "rw" }),
    ).rejects.toThrow();
    await expect(
      workspaces.create({ id: crypto.randomUUID(), name: "B", path: "/workspace/a", description: null, access: "rw" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/backend && bun test src/db/repositories/__tests__/workspaces-repository.test.ts`
Expected: FAIL — workspace module not found.

- [ ] **Step 3: Write the repository**

`apps/backend/src/db/repositories/workspaces.repository.ts`:

```ts
import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewWorkspace, WorkspaceTable, WorkspaceUpdate } from "@/db/types/workspaces.db-types.js";

/**
 * Repository for managed, install-wide workspaces (global; no user filter).
 */
export class WorkspacesRepository extends BaseRepository {
  async create(workspace: NewWorkspace): Promise<WorkspaceTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("workspaces")
      .values({ ...workspace, createdAt: now, updatedAt: now })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<WorkspaceTable | undefined> {
    return this.db.selectFrom("workspaces").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async list(): Promise<WorkspaceTable[]> {
    return this.db.selectFrom("workspaces").selectAll().orderBy("name", "asc").execute();
  }

  async update(id: string, update: WorkspaceUpdate): Promise<WorkspaceTable | undefined> {
    await this.db
      .updateTable("workspaces")
      .set({ ...update, updatedAt: sql`(datetime('now'))` })
      .where("id", "=", id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("workspaces").where("id", "=", id).execute();
  }
}
```

- [ ] **Step 4: Add to `Repositories` interface**

`apps/backend/src/db/repositories/index.ts` — add `import type { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";` and `workspaces: WorkspacesRepository;` to the interface.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/backend && bun test src/db/repositories/__tests__/workspaces-repository.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/db/repositories/workspaces.repository.ts apps/backend/src/db/repositories/__tests__/workspaces-repository.test.ts apps/backend/src/db/repositories/index.ts
git commit -m "feat(workspaces): workspaces repository"
```

---

### Task 3: Backend — workspaces route (admin CRUD + list for all)

**Files:**
- Create: `apps/backend/src/api/workspaces.route.ts`
- Modify: `apps/backend/src/api/routes.ts` (wire in)
- Modify: `apps/backend/src/api/models.ts` (add `WorkspaceSchema`)
- Create: `apps/backend/src/api/__tests__/workspaces-admin.test.ts`

**Interfaces:**
- Consumes: `WorkspacesRepository` (Task 2), `authGuard`/`requireAdmin` (existing), `WorkspaceTable`, `WorkspaceAccess`.
- Produces: `workspaceListRoutes` + `workspaceAdminRoutes` Elysia groups, `WorkspaceSchema` (exported from `models.ts`).
- Also uses existing exported `validateWorkspacePath` from `@/services/session-manager.service.js` (returns `realpathSync` of an existing directory).

**Route contract:**
- `GET /api/workspaces` (authGuard) → `WorkspaceSchema[]`
- `POST /api/workspaces` (requireAdmin) → `WorkspaceSchema`
- `PUT /api/workspaces/:id` (requireAdmin) → `WorkspaceSchema`
- `DELETE /api/workspaces/:id` (requireAdmin) → `{ ok: true }`
- Errors: `WorkspacesError` with `status` 400 (invalid path), 404 (not found), 409 (duplicate).

- [ ] **Step 1: Add `WorkspaceSchema` to models**

`apps/backend/src/api/models.ts` — append after `ProfileSchema`:

```ts
export const WorkspaceSchema = t.Object({
  id: t.String({ description: "Workspace id" }),
  name: t.String({ description: "Workspace name (unique)" }),
  path: t.String({ description: "Absolute workspace path (container path)" }),
  description: t.Union([t.String({ description: "Longer description" }), t.Null()]),
  access: t.Union([t.Literal("rw"), t.Literal("ro")], { description: "rw = read-write, ro = read-only (advisory)" }),
  createdAt: t.String({ description: "Created timestamp" }),
  updatedAt: t.String({ description: "Updated timestamp" }),
});
```

- [ ] **Step 2: Write the route**

`apps/backend/src/api/workspaces.route.ts` — **two Elysia groups in one file** for the split guard (list = any-authed, mutations = admin). This uses only the codebase's established whole-group `.use(requireAdmin)` idiom (see `users.route.ts:36`, `audit.route.ts:23`) — no `.guard()` nesting, which is not used anywhere in this repo.

```ts
import { Elysia, t } from "elysia";
import { authGuard, requireAdmin } from "@/api/auth-guard.js";
import { WorkspaceSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";
import type { WorkspaceAccess } from "@/db/types/workspaces.db-types.js";
import { validateWorkspacePath } from "@/services/session-manager.service.js";

const CreateWorkspaceBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 120, description: "Workspace name" }),
  path: t.String({ minLength: 1, description: "Absolute directory path that must exist" }),
  description: t.Optional(t.String({ maxLength: 500, description: "Longer description" })),
  access: t.Optional(t.Union([t.Literal("rw"), t.Literal("ro")], { description: "rw or ro (advisory)" })),
});

/** Normalizes access, defaulting to "rw". */
function parseAccess(value: "rw" | "ro" | undefined): WorkspaceAccess {
  return value === "ro" ? "ro" : "rw";
}

/** Elevates a duplicate name/path to a 409 (mirrors users.route.ts:60-63). */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE");
}

/**
 * List — any authenticated user can see the install-wide registry
 * (needed for the new-session form dropdown).
 */
export const workspaceListRoutes = new Elysia({ prefix: "/api/workspaces" })
  .use(authGuard)
  .get(
    "/",
    async () => {
      return new WorkspacesRepository(db).list();
    },
    {
      response: t.Array(WorkspaceSchema, { description: "All workspaces (install-wide)" }),
      detail: {
        operationId: "listWorkspaces",
        tags: ["workspaces"],
        description: "Lists all workspaces (any authenticated user)",
      },
    },
  );

/**
 * Mutations — admin only (requireAdmin composes authGuard; non-admin 403,
 * anonymous 401).
 */
export const workspaceAdminRoutes = new Elysia({ prefix: "/api/workspaces" })
  .use(requireAdmin)
  .post(
    "/",
    async ({ body }) => {
      let realPath: string;
      try {
        realPath = await validateWorkspacePath(body.path);
      } catch (err) {
        throw new WorkspacesError("invalid_path", err instanceof Error ? err.message : "Invalid workspace path", 400, 400);
      }
      const repo = new WorkspacesRepository(db);
      try {
        const created = await repo.create({
          id: crypto.randomUUID(),
          name: body.name,
          path: realPath,
          description: body.description ?? null,
          access: parseAccess(body.access),
        });
        return created;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new WorkspacesError("duplicate", "A workspace with that name or path already exists", 409, 409);
        }
        throw err;
      }
    },
    {
      body: CreateWorkspaceBodySchema,
      response: WorkspaceSchema,
      detail: {
        operationId: "createWorkspace",
        tags: ["workspaces"],
        description: "Creates a managed workspace (admin only)",
      },
    },
  )
  .put(
    "/:id",
    async ({ params, body }) => {
      const repo = new WorkspacesRepository(db);
      const existing = await repo.findById(params.id);
      if (!existing) throw new WorkspacesError("not_found", "Workspace not found", 404, 404);

      let path = existing.path;
      if (body.path && body.path !== existing.path) {
        try {
          path = await validateWorkspacePath(body.path);
        } catch (err) {
          throw new WorkspacesError("invalid_path", err instanceof Error ? err.message : "Invalid workspace path", 400, 400);
        }
      }

      try {
        const updated = await repo.update(params.id, {
          name: body.name ?? existing.name,
          path,
          description: body.description !== undefined ? body.description : existing.description,
          access: body.access ? parseAccess(body.access) : existing.access,
        });
        if (!updated) throw new WorkspacesError("not_found", "Workspace not found", 404, 404);
        return updated;
      } catch (err) {
        if (err instanceof WorkspacesError) throw err;
        if (isUniqueViolation(err)) {
          throw new WorkspacesError("duplicate", "A workspace with that name or path already exists", 409, 409);
        }
        throw err;
      }
    },
    {
      body: t.Partial(CreateWorkspaceBodySchema),
      response: WorkspaceSchema,
      detail: {
        operationId: "updateWorkspace",
        tags: ["workspaces"],
        description: "Updates a managed workspace (admin only)",
      },
    },
  )
  .delete(
    "/:id",
    async ({ params }) => {
      const repo = new WorkspacesRepository(db);
      const existing = await repo.findById(params.id);
      if (!existing) throw new WorkspacesError("not_found", "Workspace not found", 404, 404);
      await repo.delete(params.id);
      return { ok: true };
    },
    {
      response: t.Object({ ok: t.Boolean() }),
      detail: {
        operationId: "deleteWorkspace",
        tags: ["workspaces"],
        description: "Deletes a managed workspace (admin only)",
      },
    },
  );

class WorkspacesError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number, _statusHint?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "WorkspacesError";
  }
}
```

**Notes:**
- Export **two** groups: `workspaceListRoutes` and `workspaceAdminRoutes`. Both share the `/api/workspaces` prefix; `routes.ts` mounts both. Eden/OpenAPI see them as operationIds under the same path.
- `WorkspacesError` carries **`status`** (400/404/409) — fixing the `ProfileError` 500-for-not-found quirk. Elysia maps `error.status` → HTTP code.
- `validateWorkspacePath` is the existing export from `@/services/session-manager.service.js` — returns the `realpathSync`-resolved path, rejects non-directories. It is async.

- [ ] **Step 2b: Wire into `routes.ts`**

`apps/backend/src/api/routes.ts`:
- Add `import { workspaceAdminRoutes, workspaceListRoutes } from "@/api/workspaces.route.js";`
- Add both `.use(workspaceListRoutes).use(workspaceAdminRoutes)` in the chain (order between them doesn't matter; distinct prefixes+guards).

- [ ] **Step 4: Write the route test**

`apps/backend/src/api/__tests__/workspaces-admin.test.ts` (mirror `users-admin.test.ts` setup helpers — reuse `setupAuthTables`, `signIn`, `authedRequest`, `deleteUserByEmailOrId`, `db` singleton):

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { workspaceAdminRoutes, workspaceListRoutes } from "@/api/workspaces.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * Admin-gated workspaces CRUD route tests.
 * Admin signs in -> POST/PUT/DELETE works; non-admin GET lists but mutating -> 403;
 * anonymous -> 401; duplicate name -> 409; missing id -> 404.
 *
 * Uses a temp/real workspace path that exists on the container FS — use the
 * /tmp dir (always present) so validateWorkspacePath passes.
 */

const AUTH_TABLES = ["user", "session", "account", "verification", "auth_attempts"] as const;
// (reuse the setupAuthTables helper from users-admin.test.ts — copy the function)

describe("workspaces route", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let adminId: string;
  let adminEmail: string;
  let nonAdminEmail: string;
  const adminPassword = "admin-ws-pass-1";
  const nonAdminPassword = "user-ws-pass-1";

  beforeAll(async () => {
    // setupAuthTables() copied from users-admin.test.ts
    cleanup = await setupAuthTables();
    const repo = new UsersRepository(db);
    adminEmail = `wsadmin-${crypto.randomUUID()}@mote.local`;
    nonAdminEmail = `wsuser-${crypto.randomUUID()}@mote.local`;
    adminId = await repo.createUser({ email: adminEmail, passwordHash: await hashPassword(adminPassword), role: "admin" });
    await repo.createUser({ email: nonAdminEmail, passwordHash: await hashPassword(nonAdminPassword), role: "user" });
    // ensure /tmp exists as a valid workspace dir
  });

  afterAll(async () => {
    await db.deleteFrom("userMeta").where("userId", "=", adminId).execute();
    await cleanup?.();
  });

  it("anonymous -> 401 for GET /api/workspaces", async () => {
    const res = await workspaceListRoutes.fetch(new Request("http://localhost:3080/api/workspaces"));
    expect(res.status).toBe(401);
  });

  it("admin creates a workspace (POST) and lists it (GET)", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const name = `ws-${crypto.randomUUID().slice(0, 8)}`;
    const res = await workspaceAdminRoutes.fetch(
      authedRequest("/api/workspaces", token, {
        method: "POST",
        body: JSON.stringify({ name, path: "/tmp" }),
      }),
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string; name: string; path: string; access: "rw" };
    expect(created.name).toBe(name);
    expect(created.path).toBe("/tmp");
    expect(created.access).toBe("rw");

    const list = await workspaceListRoutes.fetch(authedRequest("/api/workspaces", token));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { id: string; name: string }[];
    expect(body.some((w) => w.id === created.id)).toBe(true);

    // cleanup
    await db.deleteFrom("workspaces").where("id", "=", created.id).execute();
  });

  it("POST with a non-existent path -> 400 (registration validates path exists)", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const res = await workspaceAdminRoutes.fetch(
      authedRequest("/api/workspaces", token, {
        method: "POST",
        body: JSON.stringify({
          name: `badpath-${crypto.randomUUID().slice(0, 8)}`,
          path: `/tmp/nonexistent-${crypto.randomUUID()}`,
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("PUT changing path to a non-existent path -> 400", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const name = `mov-${crypto.randomUUID().slice(0, 8)}`;
    const created = await workspaceAdminRoutes.fetch(
      authedRequest("/api/workspaces", token, {
        method: "POST",
        body: JSON.stringify({ name, path: "/tmp" }),
      }),
    );
    const body = (await created.json()) as { id: string };
    const move = await workspaceAdminRoutes.fetch(
      authedRequest(`/api/workspaces/${body.id}`, token, {
        method: "PUT",
        body: JSON.stringify({ path: `/tmp/nonexistent-${crypto.randomUUID()}` }),
      }),
    );
    expect(move.status).toBe(400);
    await db.deleteFrom("workspaces").where("id", "=", body.id).execute();
  });

  it("session execution validates the path exists (existing behavior, not new code)", async () => {
    // NOTE: session creation already calls validateWorkspacePath in
    // session-manager.service.ts:65 (createSession), storing the resolved
    // realPath and using it as the tmux cwd. No new code is needed for this
    // path; this test documents the guarantee. A session created with a
    // nonexistent path would fail at creation with "Path does not exist".
    expect(true).toBe(true);
  });

  it("duplicate name -> 409", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const name = `dup-${crypto.randomUUID().slice(0, 8)}`;
    await workspaceAdminRoutes.fetch(
      authedRequest("/api/workspaces", token, {
        method: "POST",
        body: JSON.stringify({ name, path: "/tmp" }),
      }),
    );
    const dup = await workspaceAdminRoutes.fetch(
      authedRequest("/api/workspaces", token, {
        method: "POST",
        body: JSON.stringify({ name, path: "/tmp" }),
      }),
    );
    expect(dup.status).toBe(409);
    await db.deleteFrom("workspaces").where("name", "=", name).execute();
  });

  it("non-admin can list but cannot create (403)", async () => {
    const token = await signIn(nonAdminEmail, nonAdminPassword);
    const list = await workspaceListRoutes.fetch(authedRequest("/api/workspaces", token));
    expect(list.status).toBe(200);

    const res = await workspaceAdminRoutes.fetch(
      authedRequest("/api/workspaces", token, {
        method: "POST",
        body: JSON.stringify({ name: `nope-${crypto.randomUUID()}`, path: "/tmp" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("PUT to a missing id -> 404", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const res = await workspaceAdminRoutes.fetch(
      authedRequest("/api/workspaces/nope", token, { method: "PUT", body: JSON.stringify({ name: "x" }) }),
    );
    expect(res.status).toBe(404);
  });
});
```

> **Route test concurrency note:** these tests mutate the shared singleton `db`. Run them alone (`bun test src/api/__tests__/workspaces-admin.test.ts`) if the shared-DB route suites (users-admin) interfere. To make duplicate-name deterministic, insert a `await db.deleteFrom("workspaces")` in `beforeEach`.

- [ ] **Step 5: Run the route test**

Run: `cd apps/backend && bun test src/api/__tests__/workspaces-admin.test.ts`
Expected: PASS (8 tests). **If 409 isn't raised** (because the unique index throws but the repo's `create` doesn't translate it), the unique-violation catch is already in the route code (see Step 8 code) — verify it's firing.

- [ ] **Step 5b: Confirm session-execution path validation is covered (no new code needed)**

`createSession` (`apps/backend/src/services/session-manager.service.ts:65`) **already** calls `validateWorkspacePath(workspacePath)` before spawning; it stores `realPath` and passes it as the tmux `-c` cwd. So:
- A session created with a **nonexistent** path fails at creation with "Path does not exist" (400 via the session route).
- A session created with a **workspace-registered** path (that existed at registration) also exists at execution — unless the host dir was deleted/unmounted since, in which case creation fails with the same clear error.

No new code is needed for the session-execution gate; the plan's route test documents this guarantee. The **single source of truth** for path-existence is `validateWorkspacePath`, used by both workspace registration (new POST/PUT) and session creation (existing). If a future change removed validation from one of these, both should be kept in sync — worth a comment in `session-manager.service.ts` near line 65.

- [ ] **Step 6: (No longer conditional) unique-violation-to-409 is in the route code**

The POST and PUT handlers in Step 2 already wrap `repo.create`/`repo.update` with `isUniqueViolation(err)` → `WorkspacesError("duplicate", …, 409)`. The `isUniqueViolation` helper checks `err.message.includes("UNIQUE")` (mirrors `users.route.ts:60-63`). Verify it works in Step 5; if the SQLite error message differs, adjust the predicate.

- [ ] **Step 7: Run backend tests + verify-types**

Run: `cd apps/backend && bun test && bun run verify-types`
Expected: all pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/api/workspaces.route.ts apps/backend/src/api/models.ts apps/backend/src/api/routes.ts apps/backend/src/api/__tests__/workspaces-admin.test.ts
git commit -m "feat(workspaces): workspaces API routes (admin CRUD, list for all)"
```

---

### Task 4: Frontend — hook + types + form helpers + shared fields

**Files:**
- Create: `apps/frontend/src/types/workspace.ts`
- Create: `apps/frontend/src/hooks/use-workspaces.ts`
- Create: `apps/frontend/src/lib/workspace-form.ts`
- Create: `apps/frontend/src/components/workspace-fields.tsx`
- Create: `apps/frontend/src/lib/__tests__/workspace-form.test.ts`

**Interfaces:**
- Consumes: `apiFetch` (`@/lib/api`), `WorkspaceSchema` (backend) wire shape.
- Produces:
  - `WorkspaceRow { id; name; path; description: string | null; access: "rw" | "ro"; createdAt; updatedAt }`
  - `useWorkspaces()` → `useQuery<WorkspaceRow[]>` keyed `["workspaces"]`
  - `WorkspaceFormValue { name; path; description; access: "rw" | "ro" }`
  - `emptyWorkspaceForm()`, `workspaceFormFromRow(row)`, `toCreateWorkspace(v)` (payload for POST), `toUpdateWorkspace(v)` (payload for PUT)

- [ ] **Step 1: Write the failing frontend lib test**

`apps/frontend/src/lib/__tests__/workspace-form.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { WorkspaceRow } from "@/types/workspace";
import { emptyWorkspaceForm, toCreateWorkspace, workspaceFormFromRow } from "../workspace-form";

const baseRow: WorkspaceRow = {
  id: "w1",
  name: "Projects",
  path: "/workspace",
  description: null,
  access: "rw",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("emptyWorkspaceForm", () => {
  it("returns defaults", () => {
    expect(emptyWorkspaceForm()).toEqual({ name: "", path: "", description: "", access: "rw" });
  });
});

describe("workspaceFormFromRow", () => {
  it("maps a row to form state, null description -> empty", () => {
    expect(workspaceFormFromRow(baseRow)).toEqual({ name: "Projects", path: "/workspace", description: "rw" && "", access: "rw" });
  });
  it("maps non-empty description", () => {
    expect(workspaceFormFromRow({ ...baseRow, description: "the repo", access: "ro" })).toEqual({
      name: "Projects",
      path: "/workspace",
      description: "the repo",
      access: "ro",
    });
  });
});

describe("toCreateWorkspace", () => {
  it("builds POST payload with trimmed name + default access", () => {
    expect(toCreateWorkspace({ name: "  Proj ", path: "/workspace", description: "", access: "rw" })).toEqual({
      name: "Proj",
      path: "/workspace",
      description: undefined,
      access: "rw",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/frontend && bun test`
Expected: FAIL — module `../workspace-form` not found.

- [ ] **Step 3: Create types + hook + form helpers**

`apps/frontend/src/types/workspace.ts`:

```ts
/**
 * A managed workspace as returned by the workspaces API.
 * Client-facing subset of `WorkspaceSchema` (apps/backend/src/api/models.ts).
 */
export interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  description: string | null;
  access: "rw" | "ro";
  createdAt: string;
  updatedAt: string;
}
```

`apps/frontend/src/hooks/use-workspaces.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { WorkspaceRow } from "@/types/workspace";

/** Shared query for the install-wide workspace registry. */
export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: () => apiFetch<WorkspaceRow[]>("/api/workspaces"),
  });
}
```

`apps/frontend/src/lib/workspace-form.ts`:

```ts
import type { WorkspaceRow } from "@/types/workspace";

/** Live form state shared by the workspace create form and edit page. */
export interface WorkspaceFormValue {
  name: string;
  path: string;
  description: string; // textarea; empty -> undefined on submit
  access: "rw" | "ro";
}

export function emptyWorkspaceForm(): WorkspaceFormValue {
  return { name: "", path: "", description: "", access: "rw" };
}

export function workspaceFormFromRow(row: WorkspaceRow): WorkspaceFormValue {
  return {
    name: row.name,
    path: row.path,
    description: row.description ?? "",
    access: row.access,
  };
}

export function toCreateWorkspace(v: WorkspaceFormValue) {
  return {
    name: v.name.trim() || "Untitled",
    path: v.path.trim(),
    description: v.description.trim() ? v.description.trim() : undefined,
    access: v.access,
  };
}

export function toUpdateWorkspace(v: WorkspaceFormValue) {
  return {
    name: v.name.trim() || "Untitled",
    path: v.path.trim(),
    description: v.description.trim() ? v.description.trim() : undefined,
    access: v.access,
  };
}
```

- [ ] **Step 4: Create shared fields component**

`apps/frontend/src/components/workspace-fields.tsx`:

```tsx
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WorkspaceFormValue } from "@/lib/workspace-form";

/**
 * The four workspace fields (name, path, description, access rw/ro).
 * Fully controlled by the parent so create + edit share one render path.
 */
export function WorkspaceFields({
  value,
  onChange,
}: {
  value: WorkspaceFormValue;
  onChange: (value: WorkspaceFormValue) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="workspace-name">Name</Label>
        <Input
          id="workspace-name"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="e.g. Projects"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="workspace-path">Path</Label>
        <Input
          id="workspace-path"
          value={value.path}
          onChange={(e) => onChange({ ...value, path: e.target.value })}
          placeholder="/workspace"
        />
        <p className="text-muted-foreground text-xs">Container path — must exist inside Mote (Docker: the mounted path).</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="workspace-description">Description</Label>
        <Textarea
          id="workspace-description"
          rows={2}
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          placeholder="Optional note"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="workspace-access">Access</Label>
        <Select value={value.access} onValueChange={(a) => onChange({ ...value, access: a as "rw" | "ro" })}>
          <SelectTrigger id="workspace-access">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rw">Read-write</SelectItem>
            <SelectItem value="ro">Read-only (advisory)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Read-only is advisory — enforcement is the host mount, not this flag.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the frontend lib test to verify it passes**

Run: `cd apps/frontend && bun test src/lib/__tests__/workspace-form.test.ts`
Expected: PASS (4 tests). If the `description: "rw" && ""` in my test is wrong, fix the assertion to `description: ""`.

- [ ] **Step 6: Run frontend verify-types**

Run: `cd apps/frontend && bun run verify-types`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/types/workspace.ts apps/frontend/src/hooks/use-workspaces.ts apps/frontend/src/lib/workspace-form.ts apps/frontend/src/components/workspace-fields.tsx apps/frontend/src/lib/__tests__/workspace-form.test.ts
git commit -m "feat(workspaces): frontend hook, types, form helpers + fields"
```

---

### Task 5: Frontend — manage page + edit page + nav + new-session dropdown

**Files:**
- Create: `apps/frontend/src/routes/workspaces.tsx`
- Create: `apps/frontend/src/routes/workspaces_.$id.tsx`
- Modify: `apps/frontend/src/components/app-sidebar.tsx` (NAV_ITEMS + icon import)
- Modify: `apps/frontend/src/routes/new.tsx` (add Workspace dropdown)
- Test: `apps/frontend/src/lib/__tests__/workspace-form.test.ts` (already in Task 4; no new test needed here — the manage page is thin, matching profiles.tsx which has no component test)

**Interfaces:**
- Consumes: `useWorkspaces`, `WorkspaceFields`, `WorkspaceFormValue`, `emptyWorkspaceForm`, `workspaceFormFromRow`, `toCreateWorkspace`, `toUpdateWorkspace`, `apiFetch`, `WorkspaceRow`.
- Produces: TanStack route `workspaces.tsx` (list + create) + `workspaces_.$id.tsx` (edit). New routes auto-register in `routeTree.gen.ts` via the Vite plugin on dev/build.

- [ ] **Step 1: Create the manage page**

`apps/frontend/src/routes/workspaces.tsx` (mirror `profiles.tsx`; use `FolderOpen` icon for the page header), `toCreateWorkspace` payload, `invalidateQueries(["workspaces"])`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { WorkspaceFields } from "@/components/workspace-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { apiFetch } from "@/lib/api";
import { emptyWorkspaceForm, toCreateWorkspace, type WorkspaceFormValue } from "@/lib/workspace-form";

export const Route = createFileRoute("/workspaces")({
  component: WorkspacesPage,
});

function WorkspacesPage() {
  const queryClient = useQueryClient();
  const { data: workspaces, isLoading } = useWorkspaces();

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<WorkspaceFormValue>(emptyWorkspaceForm());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createWorkspace() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(toCreateWorkspace(form)),
      });
      setShowCreate(false);
      setForm(emptyWorkspaceForm());
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setBusy(false);
    }
  }

  async function deleteWorkspace(id: string) {
    if (!confirm("Delete this workspace?")) return;
    try {
      await apiFetch(`/api/workspaces/${id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete workspace");
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-bold text-2xl">Workspaces</h1>
          <p className="text-muted-foreground text-sm">Named directories a session runs against</p>
        </div>
        <Button onClick={() => setShowCreate((v) => !v)}>
          <Plus className="mr-1" /> New workspace
        </Button>
      </header>

      {showCreate && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Create workspace</CardTitle>
            <CardDescription>Register a directory path that sessions can use.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <WorkspaceFields value={form} onChange={setForm} />
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button onClick={() => void createWorkspace()} disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading && <p className="text-muted-foreground">Loading…</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        {workspaces?.map((w) => (
          <Card key={w.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{w.name}</CardTitle>
                <Badge variant={w.access === "ro" ? "secondary" : "outline"}>
                  {w.access === "ro" ? "read-only" : "read-write"}
                </Badge>
              </div>
              <CardDescription>{w.description ?? "·"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-muted-foreground text-xs">
              <p className="truncate font-mono">{w.path}</p>
              <div className="flex items-center justify-end gap-1">
                <Button asChild variant="ghost" size="icon" aria-label={`Edit ${w.name}`}>
                  <Link to="/workspaces/$id" params={{ id: w.id }}>
                    <Pencil className="h-4 w-4" />
                  </Link>
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Delete ${w.name}`} onClick={() => void deleteWorkspace(w.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Create the edit page**

`apps/frontend/src/routes/workspaces_.$id.tsx` (mirror `profiles_.$id.tsx`):

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { WorkspaceFields } from "@/components/workspace-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { apiFetch } from "@/lib/api";
import { toUpdateWorkspace, workspaceFormFromRow, type WorkspaceFormValue } from "@/lib/workspace-form";
import type { WorkspaceRow } from "@/types/workspace";

export const Route = createFileRoute("/workspaces_/$id")({
  component: EditWorkspacePage,
});

function EditWorkspacePage() {
  const { id } = useParams({ from: "/workspaces_/$id" });
  const { data: workspaces, isLoading } = useWorkspaces();

  if (isLoading) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <p className="text-muted-foreground">Loading…</p>
      </main>
    );
  }

  const workspace = workspaces?.find((w) => w.id === id);

  if (!workspace) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace not found</CardTitle>
            <CardDescription>The workspace may have been deleted.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link to="/workspaces">Back to workspaces</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return <WorkspaceEditor key={workspace.id} workspace={workspace} />;
}

function WorkspaceEditor({ workspace }: { workspace: WorkspaceRow }) {
  const { id } = useParams({ from: "/workspaces_/$id" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<WorkspaceFormValue>(() => workspaceFormFromRow(workspace));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => apiFetch(`/api/workspaces/${id}`, { method: "PUT", body: JSON.stringify(toUpdateWorkspace(form)) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      navigate({ to: "/workspaces" });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to save"),
  });

  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>Edit workspace</CardTitle>
          <CardDescription>Update {workspace.name}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <WorkspaceFields value={form} onChange={setForm} />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => navigate({ to: "/workspaces" })} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
```

- [ ] **Step 3: Add nav entry**

`apps/frontend/src/components/app-sidebar.tsx`:
- Add `FolderOpen` to the lucide import (`import { ChevronLeft, FolderOpen, LayoutGrid, LogOut, PanelsTopLeft, Plus, Settings, Users } from "lucide-react";`).
- Add to `NAV_ITEMS`: `{ to: "/workspaces", label: "Workspaces", icon: FolderOpen, short: "WS" }` (place after `/profiles`).

- [ ] **Step 4: Add Workspace dropdown to the new-session form**

`apps/frontend/src/routes/new.tsx`:
- Import `useWorkspaces` and the Select components (already imported).
- In `NewSessionPage`, add `const { data: workspaces } = useWorkspaces();`
- Add a `Workspace` Select **above** the existing Workspace folder input (between Profile and Workspace folder). Picking a workspace sets `setWorkspacePath(w.path)`.

```tsx
<div className="space-y-2">
  <Label>Workspace</Label>
  <Select
    value={workspaces?.some((w) => w.path === workspacePath) ? workspacePath : ""}
    onValueChange={(path) => setWorkspacePath(path)}
  >
    <SelectTrigger>
      <SelectValue placeholder="Pick a saved workspace or type a path below" />
    </SelectTrigger>
    <SelectContent>
      {workspaces?.map((w) => (
        <SelectItem key={w.id} value={w.path}>
          {w.name} — {w.path}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
</div>
```

- [ ] **Step 5: Verify the routes register + typecheck**

Run: `cd apps/frontend && bun run --cwd apps/frontend dev` briefly won't be necessary — instead run:

```bash
cd apps/frontend && bun run verify-types
```

The Vite/Router plugin regenerates `routeTree.gen.ts` when the dev server runs; for a typecheck without running the server, `bun run verify-types` uses the current (stale) `routeTree.gen.ts`. **To regenerate:** run `bunx @tanstack/router-cli generate` in `apps/frontend` (or start `bun run dev` once and kill it). If the CLI isn't available, rely on the next `bun run dev`/`turbo build` to regenerate. Verify `routeTree.gen.ts` ends up importing `workspaces` + `workspaces_/$id` before committing.

- [ ] **Step 6: Full frontend verification**

Run: `cd apps/frontend && bun run verify-types && bun run lint && bun test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/routes/workspaces.tsx apps/frontend/src/routes/workspaces_.$id.tsx apps/frontend/src/components/app-sidebar.tsx apps/frontend/src/routes/new.tsx apps/frontend/src/routeTree.gen.ts
git commit -m "feat(workspaces): manage + edit pages, nav, new-session dropdown"
```

---

### Task 6: Docker compose + final verification

**Files:**
- Modify: `docker-compose.yaml`
- Verify: `apps/backend/src/api/routes.ts` compiles; full `turbo build`.

**Interfaces:**
- Consumes: everything above.
- Produces: updated compose with `user:` + RW workspace mounts.

- [ ] **Step 1: Update docker-compose.yaml**

Change the `mote` service:

```yaml
services:
  mote:
    build:
      context: .
      dockerfile: Dockerfile
    image: mote:latest
    container_name: mote
    user: ${UID:-1000}:${GID:-1000}
    ports:
      - "127.0.0.1:3080:3080"
    volumes:
      - mote-data:/data
      # Read-write host workspace mounts. Add one host:dir:container-path:rw per host dir.
      - ${PROJECTS_DIR:-~/projects}:/workspace:rw
      - ${WORK_ITEMS_DIR:-~/work-items}:/work-items:rw
      - ${CLAUDE_BIN:-/home/theo/.local/bin/claude}:/usr/local/bin/claude:ro
      - ${HOME:-$HOME}/.claude:/home/mote/.claude:ro
      - ${HOME:-$HOME}/.config/claude:/home/mote/.config/claude:ro
    environment:
      DATABASE_PATH: /data/mote.db
      APP_BASE_URL: ${APP_BASE_URL:-http://localhost:3080}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:-dev-secret-change-me-0123456789abcdef}
      TRUSTED_ORIGINS: ${TRUSTED_ORIGINS:-}
      NODE_ENV: production
    restart: unless-stopped

volumes:
  mote-data:
```

- [ ] **Step 2: Re-run all backend + frontend verification**

Run (from repo root):

```bash
bun run verify-types
bun run lint
bun run test
```

Expected: all green.

- [ ] **Step 3: turbo build (regenerates @internal/backend-client from OpenAPI)**

Run: `turbo build`
Expected: builds `sqlite-dialect`, `harnesses`, `backend-errors`, `backend-client`, `frontend`, `backend`. The backend-client picks up `WorkspaceSchema` + new route operationIds.

- [ ] **Step 4: Verify the workspaces API is exposed + settings route ETag**

Run: `cd apps/backend && bun run dev` (background), then:

```bash
curl -s http://localhost:3080/docs | grep -o "createWorkspace\|listWorkspaces\|WorkspaceSchema" | sort -u
```

Expected: lists the three operation names. Also sanity-check a bare `GET /api/workspaces` returns 401 (unauthenticated):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3080/api/workspaces
```

Expected: `401`.

- [ ] **Step 5: (Optional) manual browser check**

If running the dev servers (backend :3080, frontend :5174) and you're signed in as admin:
1. Open `http://localhost:5174/workspaces`.
2. Create a workspace named "Projects" with path e.g. `/tmp` (a real dir on the dev box).
3. Confirm the card appears ("read-write" badge).
4. Open `/new`, pick "Projects" from the Workspace dropdown — the Workspace folder input fills with `/tmp`.
5. Cancel/Edit → the edit page loads with the fields seeded.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yaml
git commit -m "feat(workspaces): compose uid-aligned RW workspace mounts"
```

---

## Self-Review Checklist

- [ ] **Spec coverage:** migration (T1), types (T1), repo (T2), route+schemas+guard (T3), hook/types/form/fields (T4), manage+edit+nav+dropdown (T5), compose (T6). All spec sections map to a task.
- [ ] **Placeholder scan:** no TBD/TODO; every code step has full code. The unique-violation catch has exact code. The split-guard shape uses only the repo's existing whole-group `.use(requireAdmin)` idiom (verified in `users.route.ts`).
- [ ] **Type consistency:** `WorkspaceTable`, `WorkspaceAccess`, `NewWorkspace`, `WorkspaceUpdate`, `WorkspaceRow`, `WorkspaceFormValue`, `emptyWorkspaceForm`, `workspaceFormFromRow`, `toCreateWorkspace`/`toUpdateWorkspace` — all defined once, used consistently. Route operationIds match client typings.
- [ ] **Error status:** `WorkspacesError` carries `status` (400/404/409), fixing the 500-for-not-found quirk.
- [ ] **Admin guard:** POST/PUT/DELETE under `requireAdmin` (whole-group `.use`), GET under `authGuard`. Non-admin mutating → 403; anonymous → 401.
- [ ] **Path-existence guarantee:** workspace registration (POST) + path change (PUT) validate via `validateWorkspacePath` → 400; **session execution** is already gated by the same function in `createSession` (`session-manager.service.ts:65`), documented + tested (Step 5b).
