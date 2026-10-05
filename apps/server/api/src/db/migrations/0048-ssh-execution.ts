import { type Kysely, sql } from "kysely";

/**
 * SSH execution half of the Gate A persistence contract (SSH-SUPPORT.md §4):
 * `ssh_runs` (dispatched structured commands), `ssh_panes` (managed SSH
 * terminals and their control state) and `ssh_terminal_execs` (the
 * exec_in_terminal recovery record). The config half is 0047.
 *
 * Index rationale, one query per index (all of them are revocation,
 * reconciliation, or quota reads the policy and sweeps must ask):
 *
 * - `idx_ssh_runs_user_created`: the owner's run list, newest first.
 * - `idx_ssh_runs_connection`: "is work active on this connection" - the
 *   connection delete/refuse-edit check (spec §4's "deletion refused while
 *   work is active") asks it by connection, not by owner.
 * - `idx_ssh_runs_active` (partial: status IN accepted|running): the quota
 *   read this migration exists for - active runs per (user, node) against 4
 *   and per node against 16 - and the revoke-cancellation sweep ("cancel the
 *   runs THIS credential initiated", spec §2) rides the companion
 *   `idx_ssh_runs_grant` partial below it. Partial because active rows are
 *   the small, hot set and completed history only grows.
 * - `ssh_panes` is keyed BY the subshell id: the generic-pane-surface gate is
 *   "does this pane have a managed row", one primary-key read on the hottest
 *   path in the feature. `idx_ssh_panes_connection` answers "which managed
 *   panes does this connection/revision have live" - the same refusal and the
 *   revocation-fences-streams sweep.
 * - `idx_ssh_terminal_execs_outstanding` (partial, state='outstanding'): the
 *   restart-recovery read - re-arm observation for the rows still outstanding
 *   in this pane's CURRENT incarnation, and only they can become `unknown`.
 *
 * `node_id` and `connection_id` on `ssh_runs` are SET NULL: deleting a node
 * or a connection must never eat the run history the spec says to retain
 * (the immutable destination snapshot travels in `config_snapshot` itself);
 * `user_id` and `subshell_id` cascade with their owners because an
 * invisible-owner row is a leak risk with no reader.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("ssh_runs")
    .addColumn("id", "text", (col) => col.primaryKey())
    // user_id / api_key_id are plain text (0001-init ownership convention;
    // see 0047's note on why an FK to better-auth's table would break the
    // node-delete cascade in app-migrations-only databases).
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("node_id", "text", (col) => col.references("nodes.id").onDelete("set null"))
    .addColumn("connection_id", "text", (col) => col.references("ssh_connections.id").onDelete("set null"))
    .addColumn("connection_revision", "integer", (col) => col.notNull())
    .addColumn("config_snapshot", "text", (col) => col.notNull())
    .addColumn("initiated_by", "text", (col) => col.notNull())
    .addColumn("grant_id", "text", (col) => col.references("ssh_grants.id").onDelete("set null"))
    .addColumn("api_key_id", "text")
    .addColumn("command", "text", (col) => col.notNull())
    .addColumn("remote_dir", "text")
    .addColumn("request_digest", "text", (col) => col.notNull())
    .addColumn("deadline_ms", "integer", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("accepted"))
    .addColumn("cancel_requested", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("cancel_local_confirmed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("deadline_hit", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("remote_status", "integer")
    .addColumn("remote_status_confirmed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("local_exit_code", "integer")
    .addColumn("local_exit_signal", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("started_at", "text")
    .addColumn("finished_at", "text")
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();
  await db.schema.createIndex("idx_ssh_runs_user_created").on("ssh_runs").columns(["user_id", "created_at"]).execute();
  await db.schema.createIndex("idx_ssh_runs_connection").on("ssh_runs").columns(["connection_id"]).execute();
  await sql`
    CREATE INDEX idx_ssh_runs_active
    ON ssh_runs (node_id, user_id)
    WHERE status IN ('accepted', 'running')
  `.execute(db);
  await sql`
    CREATE INDEX idx_ssh_runs_grant
    ON ssh_runs (grant_id)
    WHERE status IN ('accepted', 'running')
  `.execute(db);

  await db.schema
    .createTable("ssh_panes")
    .addColumn("subshell_id", "text", (col) => col.primaryKey().references("subshells.id").onDelete("cascade"))
    .addColumn("connection_id", "text", (col) => col.notNull().references("ssh_connections.id").onDelete("cascade"))
    .addColumn("connection_revision", "integer", (col) => col.notNull())
    .addColumn("initiated_by", "text", (col) => col.notNull())
    .addColumn("grant_id", "text", (col) => col.references("ssh_grants.id").onDelete("set null"))
    .addColumn("api_key_id", "text")
    .addColumn("control_owner", "text", (col) => col.notNull())
    .addColumn("control_generation", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("log_generation", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();
  await db.schema
    .createIndex("idx_ssh_panes_connection")
    .on("ssh_panes")
    .columns(["connection_id", "connection_revision"])
    .execute();

  await db.schema
    .createTable("ssh_terminal_execs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("subshell_id", "text", (col) => col.notNull().references("subshells.id").onDelete("cascade"))
    .addColumn("pane_incarnation", "text", (col) => col.notNull())
    .addColumn("initiated_by", "text", (col) => col.notNull())
    .addColumn("grant_id", "text", (col) => col.references("ssh_grants.id").onDelete("set null"))
    .addColumn("api_key_id", "text")
    .addColumn("input_generation", "integer", (col) => col.notNull())
    .addColumn("marker_token", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull().defaultTo("outstanding"))
    .addColumn("exit_code", "integer")
    .addColumn("output", "text")
    .addColumn("output_truncated", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("next_byte", "integer")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("resolved_at", "text")
    .execute();
  await sql`
    CREATE INDEX idx_ssh_terminal_execs_outstanding
    ON ssh_terminal_execs (subshell_id)
    WHERE state = 'outstanding'
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse creation order; the execs table is the leaf.
  await sql`DROP INDEX IF EXISTS idx_ssh_terminal_execs_outstanding`.execute(db);
  await db.schema.dropTable("ssh_terminal_execs").execute();
  await db.schema.dropIndex("idx_ssh_panes_connection").ifExists().execute();
  await db.schema.dropTable("ssh_panes").execute();
  await sql`DROP INDEX IF EXISTS idx_ssh_runs_grant`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_ssh_runs_active`.execute(db);
  await db.schema.dropIndex("idx_ssh_runs_connection").ifExists().execute();
  await db.schema.dropIndex("idx_ssh_runs_user_created").ifExists().execute();
  await db.schema.dropTable("ssh_runs").execute();
}
