import type { Kysely } from "kysely";

// Adds the two switches that stop wiring the subshell MCP into a pane: one per
// account, one per machine.
//
// Both default to 1, which is the deliberate inversion of the SSH (0047) and
// preview (0062) gates beside them. Those features are opt-in, so an upgrade
// leaves the fleet exactly as it was by switching them off. MCP wiring already
// happens on every launch, so "as it was" here means ON: a DEFAULT 0 would
// strip cross-agent comms from every account and machine the moment the
// migration ran, silently, and nothing else in the suite would notice.
//
// The node column is the plane's record; the machine's mirror file is written
// from it and only ever read to refuse what the row already refused.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("user_meta")
    .addColumn("mcp_enabled", "integer", (col) => col.notNull().defaultTo(1))
    .execute();
  await db.schema
    .alterTable("nodes")
    .addColumn("mcp_enabled", "integer", (col) => col.notNull().defaultTo(1))
    .execute();
  await db.schema.alterTable("nodes").addColumn("mcp_enabled_at", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("mcp_enabled_at").execute();
  await db.schema.alterTable("nodes").dropColumn("mcp_enabled").execute();
  await db.schema.alterTable("user_meta").dropColumn("mcp_enabled").execute();
}
