import { type Kysely, sql } from "kysely";

/**
 * Workspaces: a per-user tiling layout of sessions.
 *
 * `layout_json` holds the serialized dockview split tree; the panes table holds
 * only identity. These are the schema's first foreign keys, and
 * `PRAGMA foreign_keys = ON` is set in the sqlite dialect, so both cascades are
 * enforced: dropping a workspace drops its panes, and deleting a session drops
 * any pane pointing at it — which is why no application code sweeps dangling
 * panes.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("workspaces")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("layout_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createIndex("idx_workspaces_user_name")
    .on("workspaces")
    .columns(["user_id", "name"])
    .unique()
    .execute();

  await db.schema
    .createTable("workspace_panes")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("workspace_id", "text", (col) => col.notNull().references("workspaces.id").onDelete("cascade"))
    .addColumn("session_id", "text", (col) => col.notNull().references("sessions.id").onDelete("cascade"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema.createIndex("idx_workspace_panes_workspace").on("workspace_panes").column("workspace_id").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("workspace_panes").execute();
  await db.schema.dropTable("workspaces").execute();
}
