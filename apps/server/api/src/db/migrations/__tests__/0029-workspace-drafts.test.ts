import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as workspacesMigration from "@/db/migrations/0006-workspaces.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as workspaceDraftsMigration from "@/db/migrations/0029-workspace-drafts.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  workspaces: Record<string, unknown>;
}

/**
 * The workspace name index becomes partial: unique for saved workspaces, free
 * for drafts.
 *
 * Both halves matter. A draft is auto-named after the subshell it was split
 * from, so two splits from one subshell MUST both insert — under the old full
 * index the second 409ed on a name nobody typed. And saved workspaces must
 * still refuse a duplicate, or promotion ("Save workspace…") would stop being
 * the thing that re-enters the uniqueness rule.
 */
describe("migration 0029-workspace-drafts", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  /** Inserts a workspace row directly; `draft` defaults to 0 (saved), as the column does. */
  const workspace = (id: string, name: string, draft = 0, userId = "u1") =>
    db.insertInto("workspaces").values({ id, user_id: userId, name, layout_json: null, draft }).execute();

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0029-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await workspacesMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    // `sessions` → `subshells`, and `workspace_panes.session_id` with it.
    await subshellRenameMigration.up(db);
    await workspaceDraftsMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("lets one user hold several drafts under the same name", async () => {
    await workspace("d1", "api", 1);
    await workspace("d2", "api", 1);
    const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM workspaces WHERE name = 'api' AND draft = 1`.execute(
      db,
    );
    expect(r.rows[0].n).toBe(2);
  });

  it("still refuses two SAVED workspaces with the same name for one user", async () => {
    await workspace("s1", "shipping");
    await expect(workspace("s2", "shipping")).rejects.toThrow(/UNIQUE/);
    // …and another user may still reuse the name, as before.
    await workspace("s3", "shipping", 0, "u2");
  });

  it("lets a draft and a saved workspace share a name", async () => {
    await workspace("m1", "billing");
    await workspace("m2", "billing", 1);
    const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM workspaces WHERE name = 'billing'`.execute(db);
    expect(r.rows[0].n).toBe(2);
  });

  it("defaults existing rows to saved", async () => {
    // The column is NOT NULL DEFAULT 0, so a row written by code that predates
    // the flag (or by a caller that omits it) is a saved workspace.
    await db.insertInto("workspaces").values({ id: "old", user_id: "u9", name: "legacy", layout_json: null }).execute();
    const r = await sql<{ draft: number }>`SELECT draft FROM workspaces WHERE id = 'old'`.execute(db);
    expect(r.rows[0].draft).toBe(0);
  });

  it("down drops the drafts, restores the full unique index, and removes the column", async () => {
    await workspaceDraftsMigration.down(db);

    // The drafts are gone — the pre-0029 schema cannot express "unsaved", and
    // the pair named "api" is exactly what the full index cannot hold.
    const left = await sql<{ id: string }>`SELECT id FROM workspaces ORDER BY id`.execute(db);
    expect(left.rows.map((r) => r.id)).toEqual(["m1", "old", "s1", "s3"]);

    // The column is gone, so nothing can opt out of uniqueness any more.
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('workspaces')`.execute(db);
    expect(cols.rows.map((c) => c.name)).not.toContain("draft");

    await db.insertInto("workspaces").values({ id: "n1", user_id: "u1", name: "again", layout_json: null }).execute();
    await expect(
      db.insertInto("workspaces").values({ id: "n2", user_id: "u1", name: "again", layout_json: null }).execute(),
    ).rejects.toThrow(/UNIQUE/);

    await workspaceDraftsMigration.up(db); // leave the DB on the current shape
  });
});
