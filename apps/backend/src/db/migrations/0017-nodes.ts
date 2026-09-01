import { type Kysely, sql } from "kysely";

/**
 * Nodes — remote execution hosts (spec 2026-08-31 §6.1).
 *
 * - `nodes`: one row per machine. Kind "local" is the seeded control-plane
 *   host (id literally 'local', owner the system user, never connects).
 *   `api_key_id` mirrors sessions.api_key_id — the anti-forgery link the
 *   node auth path re-checks on every upgrade.
 * - `node_shares`: exact mirror of session_shares (0016); NULL grantee is
 *   "Everyone"; uniqueness enforced by the repository's transactional replace.
 * - `node_setup_keys`: single-use activation codes (SHA-256 at rest, plaintext
 *   never stored).
 * - `node_harnesses`: per-AGENT-node harness enable state; an absent row means
 *   the plugin's enabledByDefault (same lazy rule as harness_plugins).
 * - sessions.node_id defaults 'local' so every existing row keeps working.
 * - recent_paths' unique index is re-created with the node dimension
 *   (paths are per-machine); the service layer keeps profiles' node pin
 *   consistent (SET NULL on node delete — SQLite ALTER cannot add FKs).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("nodes")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("owner_user_id", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull()) // 'local' | 'agent'
    .addColumn("os", "text")
    .addColumn("arch", "text")
    .addColumn("hostname", "text")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("offline"))
    .addColumn("last_seen_at", "text")
    .addColumn("agent_version", "text")
    .addColumn("protocol_version", "integer")
    .addColumn("public_key", "text")
    .addColumn("api_key_id", "text")
    .addColumn("capabilities", "text") // JSON array from `ready`
    .addColumn("inventory_json", "text")
    .addColumn("inventory_at", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_nodes_owner_name").on("nodes").columns(["owner_user_id", "name"]).unique().execute();

  await db.schema
    .createTable("node_shares")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("grantee_user_id", "text")
    .addColumn("permission", "text", (c) => c.notNull())
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_node_shares_node").on("node_shares").column("node_id").execute();

  await db.schema
    .createTable("node_setup_keys")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("owner_user_id", "text", (c) => c.notNull())
    .addColumn("label", "text", (c) => c.notNull())
    .addColumn("key_hash", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("expires_at", "text", (c) => c.notNull())
    .addColumn("used_at", "text")
    .addColumn("consumed_node_id", "text")
    .execute();
  // Redemption looks a key up by digest (spec §5.1) — this is the index that
  // promise refers to; UNIQUE additionally pins honest duplicate digests.
  await db.schema
    .createIndex("node_setup_keys_key_hash_idx")
    .on("node_setup_keys")
    .column("key_hash")
    .unique()
    .execute();

  await db.schema
    .createTable("node_harnesses")
    .addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("harness_id", "text", (c) => c.notNull())
    .addColumn("enabled", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("pk_node_harnesses", ["node_id", "harness_id"])
    .execute();

  await db.schema
    .alterTable("sessions")
    .addColumn("node_id", "text", (c) => c.notNull().defaultTo("local"))
    .execute();
  await db.schema.alterTable("profiles").addColumn("node_id", "text").execute();
  await db.schema
    .alterTable("recent_paths")
    .addColumn("node_id", "text", (c) => c.notNull().defaultTo("local"))
    .execute();

  await db.schema.dropIndex("idx_recent_paths_user_path").execute();
  await db.schema
    .createIndex("idx_recent_paths_user_node_path")
    .on("recent_paths")
    .columns(["user_id", "node_id", "path"])
    .unique()
    .execute();
  await db.schema.createIndex("idx_sessions_node_status").on("sessions").columns(["node_id", "status"]).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_sessions_node_status").execute();
  await db.schema.dropIndex("idx_recent_paths_user_node_path").execute();
  // The index we are about to re-create is UNIQUE on (user, path), but the
  // node dimension made same-path-across-nodes legitimate data. Collapse each
  // duplicate group to its oldest row (MIN(id)) BEFORE re-creating it, or a
  // rollback aborts on honest data.
  await sql`
    DELETE FROM recent_paths
    WHERE id NOT IN (SELECT MIN(id) FROM recent_paths GROUP BY user_id, path)
  `.execute(db);
  await db.schema
    .createIndex("idx_recent_paths_user_path")
    .on("recent_paths")
    .columns(["user_id", "path"])
    .unique()
    .execute();
  await db.schema.alterTable("recent_paths").dropColumn("node_id").execute();
  await db.schema.alterTable("profiles").dropColumn("node_id").execute();
  await db.schema.alterTable("sessions").dropColumn("node_id").execute();
  await db.schema.dropTable("node_harnesses").execute();
  await db.schema.dropTable("node_setup_keys").execute();
  await db.schema.dropTable("node_shares").execute();
  await db.schema.dropTable("nodes").execute();
}
