import type { Kysely } from "kysely";

/**
 * `cross_agent`: 1 = the pane was launched by an agent, not by a human at the
 * UI — every `POST /api/subshells` that arrives on a pane's own bearer token
 * (the MCP `create_subshell` door). Such panes are internal cross-agent comms:
 * they are created with the notification bell OFF (their work is not news to
 * the human, who is usually one of the two parties talking), and the sidebar
 * files them under "Cross-agent comms" instead of mixing them into the
 * per-machine recents.
 *
 * The column records how the row was OPENED, which nothing else does:
 * `harnessId`, `presetId` and `nodeId` all survive the distinction, and a
 * later human action (rename, restart, toggling the bell) never rewrites it.
 * Existing rows default to 0 — every pane that predates the flag was opened
 * through the UI or before MCP launches existed.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("subshells")
    .addColumn("cross_agent", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("cross_agent").execute();
}
