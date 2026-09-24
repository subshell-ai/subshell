// apps/server/api/src/db/migrations/__tests__/0037-auth-providers.test.ts
import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as authProvidersMigration from "@/db/migrations/0037-auth-providers.js";
import * as approvalStateMigration from "@/db/migrations/0038-approval-state.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Raw SQL SELECTs on this handle still NAME the physical columns — a wrong
 * physical name throws "no such column", so the SQL text itself is the
 * physical check — but the CamelCasePlugin's result mapping camelizes the
 * returned row KEYS even for raw sql, hence `row.registrationEnabled`.
 */
async function migratedDb(): Promise<Kysely<any>> {
  const fresh = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(fresh);
  await authProvidersMigration.up(fresh);
  await approvalStateMigration.up(fresh);
  return fresh;
}

/** Result rows of the raw SELECTs below; values are read by `expect`, never narrowed. */
type Row = Record<string, unknown>;

async function columnNames(fresh: Kysely<any>, table: string): Promise<string[]> {
  return (await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(fresh)).rows.map(
    (r) => r.name,
  );
}

describe("migration 0037 auth_providers", () => {
  it("creates snake_case physical columns the typed queries will resolve", async () => {
    const fresh = await migratedDb();
    expect(await columnNames(fresh, "auth_providers")).toEqual([
      "id",
      "kind",
      "name",
      "issuer",
      "client_id",
      "client_secret",
      "endpoints_json",
      "entry_origins",
      "allowed_domains",
      "enabled",
      "sign_in_enabled",
      "registration_enabled",
      "require_approval",
      "position",
      "created_at",
      "updated_at",
    ]);
  });
  it("seeds the email row with the legacy-dynamic gate (NULL, not true)", async () => {
    const fresh = await migratedDb();
    const row = (await sql<Row>`SELECT * FROM auth_providers WHERE id = 'email'`.execute(fresh)).rows[0];
    expect(row.kind).toBe("email");
    expect(row.enabled).toBe(1);
    expect(row.signInEnabled).toBe(1);
    expect(row.registrationEnabled).toBeNull(); // the §2 review finding: a true default would freeze the first-run window open
    expect(row.requireApproval).toBe(0);
  });
  it("copies an existing allow_registrations row forward: false ⇒ 0", async () => {
    const fresh = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
      plugins: [new CamelCasePlugin()],
    });
    await initMigration.up(fresh);
    await sql`INSERT INTO settings (key, value, updated_at) VALUES ('allow_registrations', 'false', datetime('now'))`.execute(
      fresh,
    );
    await authProvidersMigration.up(fresh);
    const row = (await sql<Row>`SELECT registration_enabled FROM auth_providers WHERE id = 'email'`.execute(fresh))
      .rows[0];
    expect(row.registrationEnabled).toBe(0);
  });
  it("a corrupt old value copies as CLOSED (fail-closed survives the migration)", async () => {
    const fresh = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
      plugins: [new CamelCasePlugin()],
    });
    await initMigration.up(fresh);
    await sql`INSERT INTO settings (key, value, updated_at) VALUES ('allow_registrations', 'yes please', datetime('now'))`.execute(
      fresh,
    );
    await authProvidersMigration.up(fresh);
    const row = (await sql<Row>`SELECT registration_enabled FROM auth_providers WHERE id = 'email'`.execute(fresh))
      .rows[0];
    expect(row.registrationEnabled).toBe(0);
  });
  it("an upgrade with NO old row leaves the column NULL (fresh-install semantics differ, on purpose)", async () => {
    const fresh = await migratedDb(); // migratedDb inserts no settings row
    const row = (await sql<Row>`SELECT registration_enabled FROM auth_providers WHERE id = 'email'`.execute(fresh))
      .rows[0];
    expect(row.registrationEnabled).toBeNull();
  });
});

describe("migration 0038 approval_state", () => {
  it("defaults new meta rows to approved; the arrived column starts NULL", async () => {
    const fresh = await migratedDb();
    await sql`INSERT INTO user_meta (user_id, role) VALUES ('u1', 'user')`.execute(fresh);
    const row = (
      await sql<Row>`SELECT approval_state, pending_arrived_at FROM user_meta WHERE user_id = 'u1'`.execute(fresh)
    ).rows[0];
    expect(row.approvalState).toBe("approved");
    expect(row.pendingArrivedAt).toBeNull();
  });
  it("pre-existing meta rows read approved through the DEFAULT backfill", async () => {
    const fresh = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
      plugins: [new CamelCasePlugin()],
    });
    await initMigration.up(fresh);
    await sql`INSERT INTO user_meta (user_id, role) VALUES ('old', 'admin')`.execute(fresh);
    await approvalStateMigration.up(fresh); // ALTER with NOT NULL DEFAULT backfills existing rows
    const row = (await sql<Row>`SELECT approval_state FROM user_meta WHERE user_id = 'old'`.execute(fresh)).rows[0];
    expect(row.approvalState).toBe("approved");
  });
});
