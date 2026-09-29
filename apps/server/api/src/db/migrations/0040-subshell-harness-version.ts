import type { Kysely } from "kysely";

/**
 * `harness_version`: the version of the harness CLI the pane's CURRENT process
 * started on, as stamped by the server after a successful launch (issue #250
 * Phase 1). Null means unknown, which is its own honest answer for rows that
 * predate the column, panes whose version probe found nothing, and every pane
 * until its first successful stamp lands.
 *
 * It follows the PROCESS, not the row: a restart overwrites it with the
 * version the new process started on. Nothing here is a claim about the node
 * (the node's current version is the inventory's job); the comparison between
 * the two is derived at read time and stored nowhere.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").addColumn("harness_version", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("harness_version").execute();
}
