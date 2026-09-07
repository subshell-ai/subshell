import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, type Generated, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import { up as up006 } from "@/db/migrations/0006-workspaces.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  workspaces: {
    id: string;
    userId: string;
    name: string;
    description: string | null;
    layoutJson: string | null;
    createdAt: Generated<string>;
    updatedAt: Generated<string>;
  };
  workspacePanes: {
    id: string;
    workspaceId: string;
    sessionId: string;
    createdAt: Generated<string>;
    updatedAt: Generated<string>;
  };
}

describe("0006 workspaces migration", () => {
  let dbFile: string;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-006-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely({
      dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }),
      plugins: [new CamelCasePlugin()],
    });
    await initMigration.up(db);
    await operatorUxMigration.up(db);
    await remoteOpsMigration.up(db);
    await up006(db);
  });
  afterAll(() => {
    Bun.file(dbFile)
      .unlink()
      .catch(() => {});
    db.destroy().catch(() => {});
  });

  /** Inserts the profile + session rows a pane needs to point at. */
  async function seedSession(id: string): Promise<void> {
    const x = db.$extendTables<MigrationDatabase>();
    await x
      .insertInto("profiles")
      .values({
        id: `p-${id}`,
        userId: "u1",
        harnessId: "claude-code",
        name: `profile-${id}`,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
      })
      .execute();
    await x
      .insertInto("sessions")
      .values({
        id,
        userId: "u1",
        profileId: `p-${id}`,
        harnessId: "claude-code",
        name: `session-${id}`,
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();
  }

  it("creates a workspace with a null layout by default", async () => {
    await db
      .$extendTables<MigrationDatabase>()
      .insertInto("workspaces")
      .values({ id: "w1", userId: "u1", name: "refactor", description: null })
      .execute();
    const row = await db
      .$extendTables<MigrationDatabase>()
      .selectFrom("workspaces")
      .select(["id", "name", "layoutJson"])
      .where("id", "=", "w1")
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ id: "w1", name: "refactor", layoutJson: null });
  });

  it("enforces a unique workspace name per user, but not across users", async () => {
    const x = db.$extendTables<MigrationDatabase>();
    await x.insertInto("workspaces").values({ id: "w2", userId: "u2", name: "dup", description: null }).execute();
    await expect(
      x.insertInto("workspaces").values({ id: "w3", userId: "u2", name: "dup", description: null }).execute(),
    ).rejects.toThrow();
    // A different user may reuse the name.
    await x.insertInto("workspaces").values({ id: "w4", userId: "u3", name: "dup", description: null }).execute();
  });

  it("deleting a workspace cascades to its panes", async () => {
    const x = db.$extendTables<MigrationDatabase>();
    await seedSession("s1");
    await x
      .insertInto("workspaces")
      .values({ id: "w5", userId: "u1", name: "cascade-ws", description: null })
      .execute();
    await x.insertInto("workspacePanes").values({ id: "pane1", workspaceId: "w5", sessionId: "s1" }).execute();

    await x.deleteFrom("workspaces").where("id", "=", "w5").execute();
    const panes = await x.selectFrom("workspacePanes").selectAll().where("id", "=", "pane1").execute();
    expect(panes).toHaveLength(0);
  });

  it("deleting a session cascades to the panes that reference it", async () => {
    const x = db.$extendTables<MigrationDatabase>();
    await seedSession("s2");
    await x
      .insertInto("workspaces")
      .values({ id: "w6", userId: "u1", name: "cascade-sess", description: null })
      .execute();
    await x.insertInto("workspacePanes").values({ id: "pane2", workspaceId: "w6", sessionId: "s2" }).execute();

    await x.deleteFrom("sessions").where("id", "=", "s2").execute();
    const panes = await x.selectFrom("workspacePanes").selectAll().where("id", "=", "pane2").execute();
    expect(panes).toHaveLength(0);
  });
});
