import type { Kysely } from "kysely";

/**
 * Per-node directory allowlist (spec 2026-09-05).
 *
 * `node_allowed_dirs` holds the directories a node will launch subshells in.
 * NO ROWS for a node means UNRESTRICTED — the backwards-compatible default, so
 * every node that exists when this migration runs keeps behaving exactly as it
 * did. That is deliberate: an empty table must not read as "deny everything"
 * on the morning of the upgrade.
 *
 * Cascade-deletes with its node. Paths are stored already-normalized
 * (`normalizeAllowedDirs` in `@internal/subshell-protocol`): absolute, no `..`,
 * no trailing slash — so the unique index below actually collapses duplicates
 * rather than letting `/a` and `/a/` both sit there.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("node_allowed_dirs")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("path", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_node_allowed_dirs_node").on("node_allowed_dirs").column("node_id").execute();
  // (node, path) is unique: the repository replaces the whole set in a
  // transaction, but a unique index is what makes a concurrent double-write
  // fail loudly instead of silently doubling a rule.
  await db.schema
    .createIndex("idx_node_allowed_dirs_unique")
    .on("node_allowed_dirs")
    .columns(["node_id", "path"])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("node_allowed_dirs").execute();
}
