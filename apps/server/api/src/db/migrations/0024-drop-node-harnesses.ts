import type { Kysely } from "kysely";

/**
 * Drops `node_harnesses` (spec 2026-09-09 §6, §12).
 *
 * The table held per-agent harness enable state, which the control plane
 * decided. A node now owns that answer: what it has installed in
 * `<dataDir>/plugins/` IS what it offers, and the server mirrors the report in
 * `nodes.plugins_json`. Nothing reads these rows any more.
 *
 * **The data is not migrated into the new model, and that is deliberate.** An
 * enabled row said "this server permits the harness here", which is a
 * different claim from "this node has the plugin installed", and only the node
 * can make the second one. The upgrade path is the seeding step, which runs ON
 * the node and installs the built-ins it can actually provide.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("node_harnesses").ifExists().execute();
}

/**
 * Recreates the empty table.
 *
 * A down migration cannot restore the rows, and should not try to reconstruct
 * them from the plugin reports: those describe what a node HAS, not what an
 * operator once permitted.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("node_harnesses")
    .addColumn("node_id", "text", (col) => col.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("harness_id", "text", (col) => col.notNull())
    .addColumn("enabled", "integer", (col) => col.notNull())
    .addPrimaryKeyConstraint("pk_node_harnesses", ["node_id", "harness_id"])
    .execute();
}
