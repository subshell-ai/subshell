import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import { openSqliteDatabase } from "@/db/open-database.js";

async function migratedDb(): Promise<Kysely<any>> {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  await nodesMigration.up(db);
  return db;
}

async function columns(db: Kysely<any>, table: string): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return r.rows.map((c) => c.name);
}

describe("migration 0017-nodes", () => {
  it("creates nodes / node_shares / node_setup_keys / node_harnesses", async () => {
    const db = await migratedDb();
    expect(await columns(db, "nodes")).toContain("api_key_id");
    expect(await columns(db, "node_shares")).toContain("grantee_user_id");
    expect(await columns(db, "node_setup_keys")).toContain("key_hash");
    expect(await columns(db, "node_harnesses")).toContain("enabled");
  });

  it("defaults sessions.node_id to 'local' and profiles.node_id to NULL", async () => {
    const db = await migratedDb();
    await db
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p1",
        harnessId: "pi",
        name: "S",
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();
    const sess = await db.selectFrom("sessions").select("nodeId").where("id", "=", "s1").executeTakeFirstOrThrow();
    expect(sess.nodeId).toBe("local");
    // 0001-only harness: restart_on_exit/is_default arrive in 0003/0010, so the
    // fixture omits them (both are defaulted columns).
    await db
      .insertInto("profiles")
      .values({
        id: "p1",
        userId: "u1",
        harnessId: "pi",
        name: "P",
        description: "",
        envJson: "{}",
        flagsJson: "[]",
        settingsJson: null,
        configIsolation: 0,
      })
      .execute();
    const prof = await db.selectFrom("profiles").select("nodeId").where("id", "=", "p1").executeTakeFirstOrThrow();
    expect(prof.nodeId).toBeNull();
  });

  it("enforces one name per owner on nodes", async () => {
    const db = await migratedDb();
    const mk = (id: string, name: string) => ({
      id,
      ownerUserId: "u1",
      name,
      kind: "agent",
      status: "offline",
      createdAt: "t",
      updatedAt: "t",
    });
    await db.insertInto("nodes").values(mk("n1", "mac")).execute();
    // `.execute()` → a real Promise; bun's expect().rejects needs one, not Kysely's thenable
    await expect(db.insertInto("nodes").values(mk("n2", "mac")).execute()).rejects.toThrow();
    await expect(
      db
        .insertInto("nodes")
        .values({ ...mk("n3", "mac"), ownerUserId: "u2" })
        .execute(),
    ).resolves.toBeTruthy();
  });

  it("re-creates the recent_paths unique index across the node dimension", async () => {
    const db = await migratedDb();
    const mk = (id: string, node: string) => ({ id, userId: "u1", path: "/x", label: null, nodeId: node });
    await db.insertInto("recentPaths").values(mk("r1", "local")).execute();
    // same path on another node: allowed
    await expect(db.insertInto("recentPaths").values(mk("r2", "node-2")).execute()).resolves.toBeTruthy();
    // same path, same node: rejected by the unique index
    await expect(db.insertInto("recentPaths").values(mk("r3", "local")).execute()).rejects.toThrow();
  });

  it("cascade-deletes node_shares and node_harnesses with the node", async () => {
    const db = await migratedDb();
    await db
      .insertInto("nodes")
      .values({
        id: "n1",
        ownerUserId: "u1",
        name: "mac",
        kind: "agent",
        status: "offline",
        createdAt: "t",
        updatedAt: "t",
      })
      .execute();
    await db
      .insertInto("nodeShares")
      .values({
        id: "sh1",
        nodeId: "n1",
        granteeUserId: null,
        permission: "view",
        createdBy: "u1",
        createdAt: "t",
      })
      .execute();
    await db.insertInto("nodeHarnesses").values({ nodeId: "n1", harnessId: "claude-code", enabled: 1 }).execute();
    await db.deleteFrom("nodes").where("id", "=", "n1").execute();
    expect(await db.selectFrom("nodeShares").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("nodeHarnesses").selectAll().execute()).toHaveLength(0);
  });

  it("down() removes the tables and restores the old recent_paths index", async () => {
    const db = await migratedDb();
    await nodesMigration.down(db);
    const tables = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'`.execute(db);
    expect(tables.rows).toHaveLength(0);
    // old unique behavior back: same (user, path) twice fails again
    // (node_id is gone after down(), so the fixture must not mention it)
    await db.insertInto("recentPaths").values({ id: "a", userId: "u1", path: "/y", label: null }).execute();
    await expect(
      db.insertInto("recentPaths").values({ id: "b", userId: "u1", path: "/y", label: null }).execute(),
    ).rejects.toThrow();
  });
});
