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
import { openSqliteDatabase } from "@/db/open-database.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";

/**
 * `clearWaitingIfSet` is a CLAIM, and a claim's contract is the number it
 * answers with: 1 for whoever moved the row, 0 for everyone who arrived after.
 * The service publishes the live change only on the 1, so a repository that
 * answered 1 twice would double-announce a single clear — and a test on the
 * route alone cannot see that, because by the time the second request lands
 * the stamp is already gone either way. Scratch DB (same chain as
 * subshells-visible) so the schema is this file's own, not another suite's.
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

async function waitingOf(db: Kysely<Database>, id: string): Promise<string | null> {
  const row = await (db as Kysely<any>)
    .selectFrom("subshells")
    .select("waitingSince")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new Error(`fixture row ${id} is gone`);
  return row.waitingSince as string | null;
}

describe("SubshellsRepository.clearWaitingIfSet", () => {
  it("clears a set stamp and answers 1 to the caller that moved it", async () => {
    const db = await freshDb();
    await seed(db, "stamped", "2026-09-24T08:27:09.000Z");
    const repo = new SubshellsRepository(db);

    expect(await repo.clearWaitingIfSet("stamped")).toBe(1);
    expect(await waitingOf(db, "stamped")).toBeNull();
    await db.destroy();
  });

  it("answers 0 to every caller after the mover, leaving the row untouched", async () => {
    const db = await freshDb();
    await seed(db, "stamped", "2026-09-24T08:27:09.000Z");
    await seed(db, "unstamped", null);
    const repo = new SubshellsRepository(db);

    expect(await repo.clearWaitingIfSet("stamped")).toBe(1);
    // The racing `resumed` (every tool call posts one): the second caller must
    // answer 0, which is the service's cue to publish nothing.
    expect(await repo.clearWaitingIfSet("stamped")).toBe(0);
    expect(await repo.clearWaitingIfSet("unstamped")).toBe(0);
    expect(await waitingOf(db, "unstamped")).toBeNull();
    await db.destroy();
  });

  it("answers 0 for a row that does not exist", async () => {
    const db = await freshDb();
    const repo = new SubshellsRepository(db);
    expect(await repo.clearWaitingIfSet("nope")).toBe(0);
    await db.destroy();
  });
});
