import { type Kysely, sql } from "kysely";

/**
 * SSH runtime sessions (design 2026-10-05 §4, migration 0049): one row per
 * brokered destination session, and the hidden `nodes` rows that make a
 * session's panes ordinary panes.
 *
 * `ssh_runtime_sessions`:
 * - The row is the SESSION record: who opened it (`owner_id`), through which
 *   connecting node it was brokered (`connecting_node_id` - an ordinary agent
 *   node, and opening requires REAL OWNERSHIP of it, no admin boost, no
 *   share, design §4), and the reviewed destination facts (`alias`, `host`,
 *   `port`, `user`) - refs and numbers only, never identity material (§8).
 * - `runtime_node_id` names the hidden `nodes` row (kind `runtime`) that the
 *   session's PANES carry as their `nodeId`, so list/detail/log/live/ws ride
 *   the ordinary pane plumbing. `connecting_node_id` CASCADEs are avoided on
 *   purpose (SET NULL below): deleting the connecting machine loses the
 *   session's history for the audit trail, not the other way around.
 * - `status`: `opening` (spawn asked, hello not yet in) / `active` / `lost`
 *   (child died or the link dropped - design §6's honest state, panes stay
 *   `running` with `alive: 0`) / `closed` (the user's own act).
 * - `hello_json` carries the parsed runtime hello (version, os, arch, socket,
 *   dataDir, paneCount) - display + reconciliation facts. The runtime's data
 *   dir is what the plane composes the callback-socket path and artifact
 *   paths from, so it is persisted here, not only held in memory.
 *
 * Indexes: per-owner list (the history), per-connecting-node reconcile sweep
 * ("which active sessions died with this machine"), and per-runtime-node
 * pane lookup ("which session does this pane's node id belong to", asked by
 * the launcher registry and the callback executor on every command).
 *
 * The `nodes.kind` column is plain text with a comment (no CHECK constraint,
 * the 0017 posture), so the new `runtime` spelling needs no ALTER here - the
 * type is widened in `nodes.db-types.ts` and every listing query is narrowed
 * in code (design §4's "never listed" rule).
 *
 * Timestamps ride the house `strftime('%Y-%m-%dT%H:%M:%fZ','now')` default
 * (the 0040 spelling; the space-separated `datetime('now')` form sorts below
 * ISO rows and is the bug).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("ssh_runtime_sessions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("owner_user_id", "text", (col) => col.notNull())
    .addColumn("connecting_node_id", "text", (col) => col.notNull().references("nodes.id").onDelete("cascade"))
    // The hidden runtime row belongs to the SESSION (its life is the
    // session's); deleting the session deletes it, which CASCADE-deletes the
    // pane rows that name it - so session close must not orphan panes by
    // accident: the service deletes/terminates panes deliberately before
    // dropping the runtime row, same ordering as node delete today.
    .addColumn("runtime_node_id", "text", (col) => col.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("alias", "text", (col) => col.notNull())
    .addColumn("host", "text", (col) => col.notNull())
    .addColumn("port", "integer", (col) => col.notNull())
    .addColumn("user", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("opening"))
    .addColumn("hello_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("last_seen_at", "text")
    .addColumn("closed_at", "text")
    .execute();
  await db.schema
    .createIndex("idx_ssh_runtime_sessions_owner")
    .on("ssh_runtime_sessions")
    .columns(["owner_user_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("idx_ssh_runtime_sessions_connecting")
    .on("ssh_runtime_sessions")
    .columns(["connecting_node_id", "status"])
    .execute();
  await db.schema
    .createIndex("idx_ssh_runtime_sessions_runtime_node")
    .on("ssh_runtime_sessions")
    .columns(["runtime_node_id"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_ssh_runtime_sessions_runtime_node").ifExists().execute();
  await db.schema.dropIndex("idx_ssh_runtime_sessions_connecting").ifExists().execute();
  await db.schema.dropIndex("idx_ssh_runtime_sessions_owner").ifExists().execute();
  await db.schema.dropTable("ssh_runtime_sessions").execute();
}
