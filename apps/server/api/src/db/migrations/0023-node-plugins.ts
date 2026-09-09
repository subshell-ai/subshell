import type { Kysely } from "kysely";

/**
 * The node's reported plugin set, mirrored on its row (spec 2026-09-09 §6).
 *
 * A COLUMN of its own rather than a widening of `inventory_json`: that column
 * holds a JSON ARRAY of harness entries and is parsed as one by
 * `readAgentInventory`, so folding a second shape into it would mean changing
 * a parser the launch gate depends on. Two columns, two parsers, neither
 * guessing at the other's shape.
 *
 * Nullable, and null is meaningful: it is "this node has never reported", not
 * "this node offers nothing". Only a node running protocol v6 reports at all.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("nodes").addColumn("plugins_json", "text").execute();
  await db.schema.alterTable("nodes").addColumn("plugins_at", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("plugins_at").execute();
  await db.schema.alterTable("nodes").dropColumn("plugins_json").execute();
}
