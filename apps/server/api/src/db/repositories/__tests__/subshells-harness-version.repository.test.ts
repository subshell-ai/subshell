import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as notifyMigration from "@/db/migrations/0014-session-notifications.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import * as crossAgentMigration from "@/db/migrations/0039-subshell-cross-agent.js";
import * as harnessVersionMigration from "@/db/migrations/0040-subshell-harness-version.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";

/**
 * `casHarnessVersion` is a CLAIM, and a claim's contract is the boolean it
 * answers with: true for the one writer whose expected value still matches the
 * row while it is running, false for everyone who arrived after (spec
 * 2026-09-28: a create's late stamp must never clobber a restart's fresh one).
 * Scratch DB (same chain as subshells-waiting) so the schema is this file's
 * own, not another suite's.
 */
async function freshDb(): Promise<Kysely<Database>> {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db as Kysely<any>);
  await remoteOpsMigration.up(db as Kysely<any>);
  await notifyMigration.up(db as Kysely<any>); // waiting_since
  await sharingMigration.up(db as Kysely<any>);
  await nodesMigration.up(db as Kysely<any>);
  await subshellRenameMigration.up(db as Kysely<any>); // renamed schema the code sees
  await presetsMigration.up(db as Kysely<any>); // presetId/harnessId columns
  await crossAgentMigration.up(db as Kysely<any>); // subshells.cross_agent — SubshellsRepository.create writes it (2026-09-25)
  await harnessVersionMigration.up(db as Kysely<any>); // subshells.harness_version — SubshellsRepository.create writes it (2026-09-28)
  return db;
}

/**
 * Inserts a bare running row and reads back the value a CAS must name: the
 * insert leaves `started_at` NULL, and the real launch paths (create/revive)
 * pass the row's own `startedAt`, so every case here threads the read-back
 * value exactly as those callers do.
 */
async function seed(db: Kysely<Database>, id: string, waitingSince: string | null): Promise<string | null> {
  await (db as Kysely<any>)
    .insertInto("subshells")
    .values({
      id,
      userId: "u",
      presetId: "p",
      harnessId: "h",
      name: id,
      workingDir: "/tmp",
      tmuxSocket: null,
      status: "running",
      waitingSince,
    })
    .execute();
  const row = await (db as Kysely<any>)
    .selectFrom("subshells")
    .select("startedAt")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return (row.startedAt as string | null) ?? null;
}

describe("casHarnessVersion", () => {
  it("writes while the row is running and still carries the expected value", async () => {
    const db = await freshDb();
    const startedAt = await seed(db, "s1", null); // copied seeder: id, userId "u", presetId "p", harnessId "h", /tmp, running
    const repo = new SubshellsRepository(db);
    expect(await repo.casHarnessVersion("s1", null, startedAt, "2.1.283")).toBe(true);
    expect((await repo.findById("s1"))?.harnessVersion).toBe("2.1.283");
    await db.destroy();
  });

  it("a stale expected value loses the race and writes nothing", async () => {
    const db = await freshDb();
    const startedAt = await seed(db, "s1", null);
    const repo = new SubshellsRepository(db);
    expect(await repo.casHarnessVersion("s1", null, startedAt, "283")).toBe(true);
    // A second writer that still believes the pre-283 value cannot land: a
    // launch's late stamp must never clobber a restart's fresh one.
    expect(await repo.casHarnessVersion("s1", null, startedAt, "284")).toBe(false);
    expect((await repo.findById("s1"))?.harnessVersion).toBe("283");
    // And the true owner can still move it.
    expect(await repo.casHarnessVersion("s1", "283", startedAt, "284")).toBe(true);
    await db.destroy();
  });

  it("the right value with the WRONG startedAt loses, and the row is unchanged", async () => {
    // The equal-version restart the value CAS cannot see: a kick naming a
    // dead launch passes the expected check yet must write nothing, because
    // the guard in the WHERE names the launch as well as the value.
    const db = await freshDb();
    const startedAt = await seed(db, "s1", null);
    const repo = new SubshellsRepository(db);
    expect(await repo.casHarnessVersion("s1", null, startedAt, "283")).toBe(true);
    expect(await repo.casHarnessVersion("s1", "283", "2099-01-01T00:00:00.000Z", "284")).toBe(false);
    expect((await repo.findById("s1"))?.harnessVersion).toBe("283");
    await db.destroy();
  });

  it("a terminated row is not stamped", async () => {
    const db = await freshDb();
    const startedAt = await seed(db, "s1", null);
    const repo = new SubshellsRepository(db);
    await repo.markTerminated("s1", new Date().toISOString());
    expect(await repo.casHarnessVersion("s1", null, startedAt, "283")).toBe(false);
    await db.destroy();
  });

  it("a seeded row reads back with an unknown (null) version", async () => {
    const db = await freshDb();
    await seed(db, "s1", null);
    expect((await new SubshellsRepository(db).findById("s1"))?.harnessVersion).toBeNull();
    await db.destroy();
  });
});
