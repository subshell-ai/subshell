import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as localNodeNameMigration from "@/db/migrations/0022-local-node-name.js";
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

/** A node row shaped as `NodesRepository.create` writes one. */
function nodeRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "local",
    ownerUserId: "system",
    name: "Local",
    kind: "local",
    status: "online",
    os: "linux",
    arch: "x64",
    hostname: "theo-desktop",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

async function nameOf(db: Kysely<any>, id: string): Promise<string | undefined> {
  const row = await db.selectFrom("nodes").select("name").where("id", "=", id).executeTakeFirst();
  return row?.name;
}

describe("migration 0022-local-node-name", () => {
  it("renames the seeded control-plane host row to Server", async () => {
    const db = await migratedDb();
    await db.insertInto("nodes").values(nodeRow({})).execute();

    await localNodeNameMigration.up(db);

    expect(await nameOf(db, "local")).toBe("Server");
  });

  it("leaves an agent node called Local alone", async () => {
    // The rewrite is scoped by kind AND id: a user's own machine may legitimately
    // be named "Local", and it is not this migration's business.
    const db = await migratedDb();
    await db.insertInto("nodes").values(nodeRow({ id: "a1", kind: "agent", ownerUserId: "u1" })).execute();

    await localNodeNameMigration.up(db);

    expect(await nameOf(db, "a1")).toBe("Local");
  });

  it("is idempotent", async () => {
    const db = await migratedDb();
    await db.insertInto("nodes").values(nodeRow({})).execute();

    await localNodeNameMigration.up(db);
    await localNodeNameMigration.up(db);

    expect(await nameOf(db, "local")).toBe("Server");
  });

  it("rolls back to the original seed value", async () => {
    const db = await migratedDb();
    await db.insertInto("nodes").values(nodeRow({})).execute();

    await localNodeNameMigration.up(db);
    await localNodeNameMigration.down(db);

    expect(await nameOf(db, "local")).toBe("Local");
  });

  it("does nothing on an instance that has no local row yet", async () => {
    // Fresh installs seed the row AFTER migrations run, so the update must
    // simply match nothing rather than fail.
    const db = await migratedDb();

    await localNodeNameMigration.up(db);

    expect(await nameOf(db, "local")).toBeUndefined();
  });
});
