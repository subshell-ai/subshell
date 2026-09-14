import { type Kysely, sql } from "kysely";

/** True when the named table exists in this database. */
async function hasTable(db: Kysely<any>, name: string): Promise<boolean> {
  const r = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(
    db,
  );
  return r.rows.length > 0;
}

/**
 * Workspaces gain a `draft` flag, and their unique name index becomes PARTIAL
 * (spec 2026-09-14).
 *
 * Splitting a subshell creates a workspace before anyone has named it, so the
 * server needs a row that is reachable by URL, reload-safe and owned like every
 * other workspace — but invisible on `/workspaces` until it is saved.
 *
 * **Why a flag and a partial index rather than a nullable name.** A draft is
 * auto-named after the subshell it was split from, so two splits from the same
 * subshell collide immediately; under the full `(user_id, name)` unique index
 * the second split would 409 on a name the user never typed. The alternative —
 * `name: null` until saved — would push a null through every list, card, tab
 * title, sidebar entry and API schema downstream, none of which handles one
 * today. With the flag, a draft carries a real name the whole time, collisions
 * between drafts are free, and promotion ("Save workspace…") is one `UPDATE`
 * that re-enters the uniqueness rule exactly where it was.
 *
 * The index keeps its NAME (`idx_workspaces_user_name`) because it keeps its
 * job: saved workspaces are still unique per user. Only drafts step outside it.
 *
 * `workspace_panes` and `layout_json` are untouched, so the cascade, the
 * layout pruning and the ownership scoping all apply to a draft unchanged.
 *
 * Kysely's index builder cannot express a partial index, so the `WHERE` half
 * is raw `sql`.
 */
export async function up(db: Kysely<any>): Promise<void> {
  if (!(await hasTable(db, "workspaces"))) return;

  await db.schema
    .alterTable("workspaces")
    .addColumn("draft", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  await db.schema.dropIndex("idx_workspaces_user_name").ifExists().execute();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_name
    ON workspaces (user_id, name) WHERE draft = 0
  `.execute(db);

  // Backfill a stamp the repository wrote wrong. `WorkspacesRepository.update`
  // used `datetime('now')`, which yields `2026-09-13 10:00:00`, while `create`
  // and the column default write `2026-09-13T10:00:00.000Z`. A space sorts
  // BELOW a `T`, so every workspace anyone had ever renamed or re-laid-out
  // sorted as the oldest thing they owned — in the sidebar's recents and in
  // the new `?subshellId=` order alike. The writer is fixed beside this
  // migration; the rows it already wrote are fixed here, since this is the
  // migration already rewriting the table. Only `updated_at` ever took the
  // bad form. Idempotent: a `Z`-suffixed value is left alone.
  await sql`
    UPDATE workspaces
    SET updated_at = replace(updated_at, ' ', 'T') || 'Z'
    WHERE updated_at NOT LIKE '%Z'
  `.execute(db);
}

/**
 * Back to one unique name per user, over every row.
 *
 * **Drafts are DELETED rather than carried across.** Two of them may share a
 * name — that is the whole point of the partial index — so recreating the full
 * one over a database the feature was actually used on would throw, leaving a
 * half-migrated schema on exactly the hosts that exercised it. Renaming the
 * collisions (the `0028` precedent for presets) is wrong here for a different
 * reason: a draft is by definition an UNSAVED workspace, the product discards
 * one automatically the moment it drops below two panes, and the pre-0029
 * schema has no way to express "not yet saved" at all. So a downgrade keeps
 * every workspace a user chose to save and drops the ones nobody named; the
 * subshells those drafts held are untouched, since only the panes cascade.
 */
export async function down(db: Kysely<any>): Promise<void> {
  if (!(await hasTable(db, "workspaces"))) return;

  await db.schema.dropIndex("idx_workspaces_user_name").ifExists().execute();
  // Before the index, or the delete has nothing to make room for; before the
  // column drop, or there is nothing left to select on.
  await sql`DELETE FROM workspaces WHERE draft = 1`.execute(db);
  await db.schema
    .createIndex("idx_workspaces_user_name")
    .ifNotExists()
    .on("workspaces")
    .columns(["user_id", "name"])
    .unique()
    .execute();
  await db.schema.alterTable("workspaces").dropColumn("draft").execute();
}
