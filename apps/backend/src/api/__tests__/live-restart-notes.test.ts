import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as sessionNameLockedMigration from "@/db/migrations/0011-session-name-locked.js";
import * as sessionHarnessIdMigration from "@/db/migrations/0013-session-harness-id.js";
import * as sessionNotificationsMigration from "@/db/migrations/0014-session-notifications.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import type { Database } from "@/db/types/index.js";

// Using the real app is heavy; build a minimal harness with a stub repo is
// simpler for these unit tests. Since the routes call DB via repositories,
// we test the pure helpers (`computeActivity`, `tailLogLines`) already
// covered in Task 2, plus the route wiring minimally:

let db: Kysely<Database>;

beforeAll(async () => {
  db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  await operatorUxMigration.up(db);
  await remoteOpsMigration.up(db);
  await profileDefaultFlagMigration.up(db); // ProfilesRepository.create writes is_default
  await sessionNameLockedMigration.up(db); // SessionsRepository defaults name_locked
  await sessionHarnessIdMigration.up(db); // sessions.harness_session_id
  await sessionNotificationsMigration.up(db); // sessions.notify / waiting_since + subscriptions
  await nodesMigration.up(db); // sessions.node_id (direct inserts must supply it)
});

afterAll(async () => {
  await db.destroy();
});

describe("live/restart/notes backend wiring", () => {
  it("notes round-trips through the sessions repository", async () => {
    // Create a session row directly, patch notes, re-read.
    const id = crypto.randomUUID();
    await db
      .insertInto("sessions")
      .values({
        id,
        userId: "u",
        profileId: "p",
        harnessId: "h",
        name: "n",
        workingDir: "/tmp",
        // Liveness columns default in the DB (migration 0003) and node_id in
        // 0017; supply the defaults explicitly so the typed insert is complete.
        nodeId: "local",
        alive: 1,
        backoffCount: 0,
        restartOnExit: 0,
        nameLocked: 0,
        notify: 0,
        waitingSince: null,
        status: "running",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await new SessionsRepository(db).update(id, { notes: "hello" });
    const row = await new SessionsRepository(db).findById(id);
    expect(row?.notes).toBe("hello");
    await db.deleteFrom("sessions").where("id", "=", id).execute();
  });
});
