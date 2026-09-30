import type { Kysely } from "kysely";

/**
 * Cross-comm becomes an OPT-IN (operator ruling during the 2026-09-29
 * preset-launch-fields test drive): the editor gains a "Cross-shell comms"
 * toggle labeled "Enable this preset for cross-shell communication via MCP",
 * and readiness is `cross_comm_enabled AND the three launch fields filled`,
 * not the row values alone. 0042's note said "derived, never stored" — the
 * toggle supersedes that: a filled preset the operator has not switched on
 * makes no agent-facing promise. Existing rows default to OFF (0); the
 * badge re-arms per preset by an explicit act, never silently.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("presets")
    .addColumn("cross_comm_enabled", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("presets").dropColumn("cross_comm_enabled").execute();
}
