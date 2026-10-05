import { type Kysely, sql } from "kysely";

/**
 * SSH config half of the Gate A persistence contract (SSH-SUPPORT.md §4):
 * `ssh_connections` (owner + connecting node + approved normalized snapshot
 * + revision) and `ssh_grants` (per-pane, per-credential, per-revision
 * authorization). The execution half (runs, panes, terminal execs) is 0048.
 *
 * Why these index/uniqueness choices - each one answers a revocation or
 * reconciliation query the policy must be able to ask cheaply and correctly:
 *
 * - `idx_ssh_connections_user` / `_node`: the owner's settings list, and the
 *   "is this node still referenced before a node delete" fact. Node deletes
 *   CASCADE connections: the connection is a resource ON that machine, and an
 *   orphaned snapshot pointing at a removed node can never dispatch again.
 *   Runs survive the cascade via SET NULL + their immutable snapshot copy
 *   (0048).
 * - `uq_ssh_grants_active` (PARTIAL UNIQUE on connection/pane/api-key WHERE
 *   revoked_at IS NULL): the spec's "unique ACTIVE binding for that tuple".
 *   Partial rather than full because a revoked grant STAYS while its rows
 *   are reachable (re-granting the same tuple after revocation must be
 *   possible, exactly the soft-state posture of 0029's partial unique
 *   index) - but it does NOT survive forever: `subshell_id` CASCADEs, so
 *   deleting the pane takes its grant rows, active and revoked, with it,
 *   and `ssh_runs.grant_id` SET NULLs. Workstream D must not build
 *   reconciliation on "grant id resolves forever": the pane row's
 *   `api_key_id` is the survivor that answers "who authorized this", and
 *   the grant row is the live binding only while it exists.
 * - `idx_ssh_grants_pane` (partial, active only): the pane-delete cascade's
 *   companion read - "which live grants does this pane hold" on terminate,
 *   and the revocation sweep ("which grants die when this row's credential
 *   rotates").
 * - `idx_ssh_grants_connection` (connection, revision): reconciliation -
 *   "which active grants point at a revision that no longer matches the
 *   connection's current one" is the edit-invalidates-grants query, asked
 *   whenever a revision moves.
 *
 * Timestamps ride the house `strftime('%Y-%m-%dT%H:%M:%fZ','now')` default,
 * the `0040-prompts` spelling (the space-separated `datetime('now')` form is
 * the bug that sorts below ISO rows; see AGENTS.md).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("ssh_connections")
    .addColumn("id", "text", (col) => col.primaryKey())
    // user_id / granted_by_user_id are PLAIN text by house convention (the
    // 0001-init posture: `subshells.user_id` and `nodes.owner_user_id` carry
    // no FK). A real FK here would make the node-delete cascade prepare
    // better-auth's `user` table, which by design does not exist in an
    // app-migrations-only database (the 0036 boot-map test), and the app
    // never deletes users anyway - the link is ownership metadata, enforced
    // in the repository layer.
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("node_id", "text", (col) => col.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("display_name", "text", (col) => col.notNull())
    .addColumn("config_snapshot", "text", (col) => col.notNull())
    .addColumn("remote_dir", "text")
    .addColumn("revision", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();
  await db.schema.createIndex("idx_ssh_connections_user").on("ssh_connections").columns(["user_id"]).execute();
  await db.schema.createIndex("idx_ssh_connections_node").on("ssh_connections").columns(["node_id"]).execute();

  await db.schema
    .createTable("ssh_grants")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connection_id", "text", (col) => col.notNull().references("ssh_connections.id").onDelete("cascade"))
    .addColumn("connection_revision", "integer", (col) => col.notNull())
    .addColumn("subshell_id", "text", (col) => col.notNull().references("subshells.id").onDelete("cascade"))
    .addColumn("api_key_id", "text", (col) => col.notNull())
    .addColumn("granted_by_user_id", "text", (col) => col.notNull())
    .addColumn("granted_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("revoked_at", "text")
    .execute();

  // Kysely's index builder cannot express a partial index (the 0029 posture),
  // so the two WHERE-carrying indexes are raw sql.
  await sql`
    CREATE UNIQUE INDEX uq_ssh_grants_active
    ON ssh_grants (connection_id, subshell_id, api_key_id)
    WHERE revoked_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX idx_ssh_grants_pane
    ON ssh_grants (subshell_id)
    WHERE revoked_at IS NULL
  `.execute(db);
  await db.schema
    .createIndex("idx_ssh_grants_connection")
    .on("ssh_grants")
    .columns(["connection_id", "connection_revision"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse creation order: grants first (it references connections).
  await db.schema.dropIndex("idx_ssh_grants_connection").ifExists().execute();
  await sql`DROP INDEX IF EXISTS idx_ssh_grants_pane`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_ssh_grants_active`.execute(db);
  await db.schema.dropTable("ssh_grants").execute();
  await db.schema.dropIndex("idx_ssh_connections_node").ifExists().execute();
  await db.schema.dropIndex("idx_ssh_connections_user").ifExists().execute();
  await db.schema.dropTable("ssh_connections").execute();
}
