import { type Kysely, sql } from "kysely";

/** True when the named table exists in this database. */
async function hasTable(db: Kysely<any>, name: string): Promise<boolean> {
  const r = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(
    db,
  );
  return r.rows.length > 0;
}

/**
 * Workspaces stop being a draft two-state and start being a set.
 *
 * Spec 2026-10-17 (workspace-first): a workspace is a named set of
 * references to live subshells that deletes itself when its last tab
 * goes, so the `draft` half-life (0029) has nothing left to express,
 * and its unique-name machinery is ceremony a bunch of auto-titled
 * windows would trip over daily.
 *
 * Three schema facts, in the order they must run:
 *
 * 1. **Dedupe, then unique.** A subshell can no longer hold two panes in
 *    one workspace: every client surface re-implementing that check
 *    (regression #13) was four guards standing in for a missing index.
 *    The index goes on AFTER the sweep, or the migration throws on any
 *    database that exercised the double-add. The oldest row (by
 *    `created_at`, id as the same-instant tiebreak) survives: it is the
 *    tab everyone's layout already points at.
 * 2. **Drop the unique name index.** With auto-created workspaces a
 *    timestamp name reusing itself is normal, not an error. Nothing
 *    downstream reads uniqueness: every lookup is by id, and the
 *    collision 409 relabeling is deleted beside this index.
 * 3. **Drop the `draft` column.** Existing drafts PROMOTE to ordinary
 *    workspaces (a plain column drop keeps the rows): they are real
 *    arrangements people split out to work in, and the product rule now
 *    is that a workspace exists exactly as long as it has tabs, which
 *    the empty-retire path enforces at runtime for everyone alike.
 *
 * `workspace_panes` ordering (`created_at`) stays the tab order the rail
 * tree and the phone strip render; no new columns arrive.
 */
export async function up(db: Kysely<any>): Promise<void> {
  if (!(await hasTable(db, "workspaces"))) return;

  await sql`
    DELETE FROM workspace_panes WHERE EXISTS (
      SELECT 1 FROM workspace_panes p2
      WHERE p2.workspace_id = workspace_panes.workspace_id
        AND p2.subshell_id = workspace_panes.subshell_id
        AND (p2.created_at < workspace_panes.created_at
             OR (p2.created_at = workspace_panes.created_at AND p2.id < workspace_panes.id))
    )
  `.execute(db);

  await db.schema
    .createIndex("idx_workspace_panes_workspace_subshell")
    .ifNotExists()
    .on("workspace_panes")
    .columns(["workspace_id", "subshell_id"])
    .unique()
    .execute();

  await db.schema.dropIndex("idx_workspaces_user_name").ifExists().execute();
  await db.schema.alterTable("workspaces").dropColumn("draft").execute();
}

/**
 * Back to the draft model. A downgrade keeps one pane per pair (there is
 * no honest way to invent the duplicates back) and re-unique the names by
 * keeping the oldest row per `(user_id, name)` and deleting the rest —
 * workspaces that collide were auto-titled, and this schema cannot hold
 * two alike. `draft` comes back all-zero: nothing here knows which rows
 * were drafts anymore, because the forward migration erased that fact.
 */
export async function down(db: Kysely<any>): Promise<void> {
  if (!(await hasTable(db, "workspaces"))) return;

  await db.schema
    .alterTable("workspaces")
    .addColumn("draft", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
  await sql`
    DELETE FROM workspaces WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM workspaces GROUP BY user_id, name
    )
  `.execute(db);
  await db.schema
    .createIndex("idx_workspaces_user_name")
    .ifNotExists()
    .on("workspaces")
    .columns(["user_id", "name"])
    .unique()
    .execute();
  await db.schema.dropIndex("idx_workspace_panes_workspace_subshell").ifExists().execute();
}
