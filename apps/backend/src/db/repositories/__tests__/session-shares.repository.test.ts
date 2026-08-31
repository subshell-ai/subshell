import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { SessionSharesRepository } from "@/db/repositories/session-shares.repository.js";
import type { Database } from "@/db/types/index.js";

/**
 * Self-contained scratch DB (init + 0016) so the FK to `sessions` and the
 * `session_shares` table both exist without depending on another suite having
 * migrated the shared test database.
 */
async function freshDb(): Promise<Kysely<Database>> {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db as Kysely<any>);
  await sharingMigration.up(db as Kysely<any>);
  return db;
}

/** Inserts a parent session so a share row's FK is satisfied. */
async function seedSession(db: Kysely<Database>, id: string, userId: string): Promise<void> {
  await (db as Kysely<any>)
    .insertInto("sessions")
    .values({ id, userId, profileId: "p", harnessId: "h", name: id, workingDir: "/tmp", tmuxSocket: null })
    .execute();
}

describe("SessionSharesRepository", () => {
  it("replaceForSession stores Everyone + a named user; listForSession returns both", async () => {
    const db = await freshDb();
    await seedSession(db, "s1", "owner");
    const repo = new SessionSharesRepository(db);
    const rows = await repo.replaceForSession(
      "s1",
      [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: "bob", permission: "edit" },
      ],
      "owner",
    );
    expect(rows).toHaveLength(2);
    const listed = await repo.listForSession("s1");
    expect(listed.map((r) => r.granteeUserId).sort()).toEqual([null, "bob"].sort());
    const byGrantee = new Map(listed.map((r) => [r.granteeUserId, r.permission]));
    expect(byGrantee.get(null)).toBe("view");
    expect(byGrantee.get("bob")).toBe("edit");
    // Every row records who created it.
    expect(listed.every((r) => r.createdBy === "owner")).toBe(true);
    await db.destroy();
  });

  it("replaceForSession again reflects the replace — no stale rows survive", async () => {
    const db = await freshDb();
    await seedSession(db, "s1", "owner");
    const repo = new SessionSharesRepository(db);
    await repo.replaceForSession(
      "s1",
      [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: "bob", permission: "edit" },
        { granteeUserId: "carol", permission: "view" },
      ],
      "owner",
    );
    // Replacing with a smaller set must delete the prior rows, not append.
    await repo.replaceForSession("s1", [{ granteeUserId: "dave", permission: "edit" }], "owner");
    const listed = await repo.listForSession("s1");
    expect(listed.map((r) => r.granteeUserId)).toEqual(["dave"]);
    await db.destroy();
  });

  it("replaceForSession de-dupes multiple Everyone (null) rows to one", async () => {
    const db = await freshDb();
    await seedSession(db, "s1", "owner");
    const repo = new SessionSharesRepository(db);
    // Two null grantees are the same grant; SQLite unique indexes treat NULLs
    // as distinct, so the repository collapses them itself.
    await repo.replaceForSession(
      "s1",
      [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: null, permission: "edit" },
      ],
      "owner",
    );
    const listed = await repo.listForSession("s1");
    expect(listed.filter((r) => r.granteeUserId === null)).toHaveLength(1);
    await db.destroy();
  });

  it("replacing with an empty set clears all shares", async () => {
    const db = await freshDb();
    await seedSession(db, "s1", "owner");
    const repo = new SessionSharesRepository(db);
    await repo.replaceForSession("s1", [{ granteeUserId: "bob", permission: "view" }], "owner");
    await repo.replaceForSession("s1", [], "owner");
    expect(await repo.listForSession("s1")).toEqual([]);
    await db.destroy();
  });

  it("listForSessions batches: one map keyed by sessionId, empty arrays omitted-safe", async () => {
    const db = await freshDb();
    await seedSession(db, "s1", "owner");
    await seedSession(db, "s2", "owner");
    const repo = new SessionSharesRepository(db);
    await repo.replaceForSession("s1", [{ granteeUserId: "bob", permission: "view" }], "owner");
    await repo.replaceForSession("s2", [{ granteeUserId: null, permission: "edit" }], "owner");
    const map = await repo.listForSessions(["s1", "s2", "s3"]);
    expect(map.get("s1")?.map((r) => r.granteeUserId)).toEqual(["bob"]);
    expect(map.get("s2")?.map((r) => r.permission)).toEqual(["edit"]);
    // A session with no shares reads as an empty array (never undefined-by-omission).
    expect(map.get("s3")).toEqual([]);
    await db.destroy();
  });
});
