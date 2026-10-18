import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as workspacesMigration from "@/db/migrations/0006-workspaces.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as workspaceDraftsMigration from "@/db/migrations/0029-workspace-drafts.js";
import * as workspaceFirstMigration from "@/db/migrations/0058-workspace-first.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  workspaces: Record<string, unknown>;
  workspace_panes: Record<string, unknown>;
}

/**
 * Spec 2026-10-17 (workspace-first): the draft column and the unique-name
 * index go, the pane double (regression #13) becomes impossible, and every
 * existing draft promotes to an ordinary workspace.
 */
describe("migration 0058-workspace-first", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  const workspace = (id: string, name: string, draft = 0, userId = "u1") =>
    db.insertInto("workspaces").values({ id, user_id: userId, name, layout_json: null, draft }).execute();

  const pane = (id: string, workspaceId: string, subshellId: string, createdAt: string) =>
    db
      .insertInto("workspace_panes")
      .values({ id, workspace_id: workspaceId, subshell_id: subshellId, created_at: createdAt, updated_at: createdAt })
      .execute();

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0058-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await workspacesMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    await subshellRenameMigration.up(db);
    await workspaceDraftsMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(dbFile, { force: true });
  });

  it("up: dedupes pane doubles onto the oldest row, then makes the pair unique", async () => {
    // This short migration chain has no subshell matching the fake ids below,
    // and seeding one is not what this migration is about — FKs come off for
    // the setup inserts and back on before the unique-index assertions, which
    // the FK pragma does not gate.
    await sql`PRAGMA foreign_keys = OFF`.execute(db);
    await workspace("ws-1", "Doubled");
    await workspace("ws-2", "AlsoHome");
    // The same subshell twice in one workspace, plus the many-homes pair in
    // another workspace, which must survive untouched.
    await pane("p-old", "ws-1", "s-1", "2026-01-01T00:00:00.000Z");
    await pane("p-new", "ws-1", "s-1", "2026-02-01T00:00:00.000Z");
    await pane("p-other", "ws-2", "s-1", "2026-01-15T00:00:00.000Z");

    await workspaceFirstMigration.up(db);
    await sql`PRAGMA foreign_keys = ON`.execute(db);

    const left = await db.selectFrom("workspace_panes").select("id").where("workspace_id", "=", "ws-1").execute();
    expect(left.map((r) => r.id)).toEqual(["p-old"]);
    expect(await db.selectFrom("workspace_panes").select("id").where("id", "=", "p-other").execute()).toHaveLength(1);

    // The unique index now refuses a double at the schema level.
    await expect(pane("p-retry", "ws-1", "s-1", "2026-03-01T00:00:00.000Z")).rejects.toThrow("UNIQUE");
  });

  it("up: drafts promote (rows kept), names stop being unique", async () => {
    // (up already ran in the previous test on this database: schema checks here.)
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('workspaces')`
      .execute(db)
      .then((r) => r.rows.map((c) => c.name));
    expect(cols).not.toContain("draft");

    // Two identical names for one user now coexist.
    await db
      .insertInto("workspaces")
      .values([
        { id: "dup-1", user_id: "u9", name: "Oct 17, 5:21 PM", layout_json: null },
        { id: "dup-2", user_id: "u9", name: "Oct 17, 5:21 PM", layout_json: null },
      ])
      .execute();
    expect(await db.selectFrom("workspaces").select("id").where("id", "in", ["dup-1", "dup-2"]).execute()).toHaveLength(
      2,
    );
  });

  it("down: re-adds the column and re-unique the names by keeping one of each", async () => {
    await workspaceFirstMigration.down(db);

    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('workspaces')`
      .execute(db)
      .then((r) => r.rows.map((c) => c.name));
    expect(cols).toContain("draft");

    // The two identical names collapse to one survivor; nothing else was touched.
    const dups = await db.selectFrom("workspaces").select("id").where("user_id", "=", "u9").execute();
    expect(dups).toHaveLength(1);
    expect(await db.selectFrom("workspaces").select("id").where("id", "=", "ws-1").execute()).toHaveLength(1);

    // And a duplicate name now throws again, which is the index being back.
    await expect(workspace("dup-3", "Oct 17, 5:21 PM", 0, "u9")).rejects.toThrow("UNIQUE");
  });
});
