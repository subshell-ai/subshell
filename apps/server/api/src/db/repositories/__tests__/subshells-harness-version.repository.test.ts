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

async function seed(db: Kysely<Database>, id: string, waitingSince: string | null) {
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
}

describe("casHarnessVersion", () => {
  it("writes while the row is running and still carries the expected value", async () => {
    const db = await freshDb();
    await seed(db, "s1", null); // copied seeder: id, userId "u", presetId "p", harnessId "h", /tmp, running
    const repo = new SubshellsRepository(db);
    expect(await repo.casHarnessVersion("s1", null, "2.1.283")).toBe(true);
    expect((await repo.findById("s1"))?.harnessVersion).toBe("2.1.283");
    await db.destroy();
  });

  it("a stale expected value loses the race and writes nothing", async () => {
    const db = await freshDb();
    await seed(db, "s1", null);
    const repo = new SubshellsRepository(db);
    expect(await repo.casHarnessVersion("s1", null, "283")).toBe(true);
    // A second writer that still believes the pre-283 value cannot land: a
    // launch's late stamp must never clobber a restart's fresh one.
    expect(await repo.casHarnessVersion("s1", null, "284")).toBe(false);
    expect((await repo.findById("s1"))?.harnessVersion).toBe("283");
    // And the true owner can still move it.
    expect(await repo.casHarnessVersion("s1", "283", "284")).toBe(true);
    await db.destroy();
  });

  it("a terminated row is not stamped", async () => {
    const db = await freshDb();
    await seed(db, "s1", null);
    const repo = new SubshellsRepository(db);
    await repo.markTerminated("s1", new Date().toISOString());
    expect(await repo.casHarnessVersion("s1", null, "283")).toBe(false);
    await db.destroy();
  });

  it("a seeded row reads back with an unknown (null) version", async () => {
    const db = await freshDb();
    await seed(db, "s1", null);
    expect((await new SubshellsRepository(db).findById("s1"))?.harnessVersion).toBeNull();
    await db.destroy();
  });
});
