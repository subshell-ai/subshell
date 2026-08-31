import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { SessionSharesRepository } from "@/db/repositories/session-shares.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import type { Database } from "@/db/types/index.js";

/**
 * Visibility is the WHERE-clause half of the sharing feature; it must be
 * pinned independently of the resolver (session-access) and the service. The
 * scratch DB (init + 0016) gives both `sessions` and `session_shares` without
 * relying on another suite having migrated the shared test database.
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

async function seed(db: Kysely<Database>, id: string, userId: string, status = "running") {
  await (db as Kysely<any>)
    .insertInto("sessions")
    .values({ id, userId, profileId: "p", harnessId: "h", name: id, workingDir: "/tmp", tmuxSocket: null, status })
    .execute();
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("SessionsRepository.listVisibleTo", () => {
  it("a viewer sees own + Everyone-shared + named-shared, never a private foreign session", async () => {
    const db = await freshDb();
    await seed(db, "a_priv", "alice");
    await seed(db, "a_everyone", "alice");
    await seed(db, "a_bob", "alice");
    await seed(db, "c_priv", "carol");
    await seed(db, "b_own", "bob");
    const shares = new SessionSharesRepository(db);
    await shares.replaceForSession("a_everyone", [{ granteeUserId: null, permission: "view" }], "alice");
    await shares.replaceForSession("a_bob", [{ granteeUserId: "bob", permission: "edit" }], "alice");

    const sessions = new SessionsRepository(db);
    expect(ids(await sessions.listVisibleTo("bob", false))).toEqual(["a_bob", "a_everyone", "b_own"]);
    expect(ids(await sessions.listVisibleTo("alice", false))).toEqual(["a_bob", "a_everyone", "a_priv"]);
    // carol is in no grant except Everyone → she sees her own + the Everyone row only.
    expect(ids(await sessions.listVisibleTo("carol", false))).toEqual(["a_everyone", "c_priv"]);
    await db.destroy();
  });

  it("an admin sees every session regardless of ownership or grants", async () => {
    const db = await freshDb();
    await seed(db, "a_priv", "alice");
    await seed(db, "c_priv", "carol");
    await seed(db, "b_own", "bob");
    const sessions = new SessionsRepository(db);
    expect(ids(await sessions.listVisibleTo("root", true))).toEqual(["a_priv", "b_own", "c_priv"]);
    await db.destroy();
  });

  it("the status filter narrows the visible set", async () => {
    const db = await freshDb();
    await seed(db, "run", "bob", "running");
    await seed(db, "done", "bob", "terminated");
    await seed(db, "shared_run", "alice", "running");
    const shares = new SessionSharesRepository(db);
    await shares.replaceForSession("shared_run", [{ granteeUserId: "bob", permission: "view" }], "alice");
    const sessions = new SessionsRepository(db);
    expect(ids(await sessions.listVisibleTo("bob", false, "running"))).toEqual(["run", "shared_run"]);
    expect(ids(await sessions.listVisibleTo("bob", false, "terminated"))).toEqual(["done"]);
    await db.destroy();
  });
});
