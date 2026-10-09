import type { Kysely } from "kysely";

/**
 * The relay pane remembers its key home (spec 2026-10-08 §7, Task 14). A
 * relay launch chose its key home A at the door that could name it, and the
 * relay session itself is plane-memory with a 30 s lifetime; "Set up Subshell
 * here" RE-OPENS that pairing minutes or hours later, and the only durable
 * fact of which A authorized the pane was the launch's audit row. The act may
 * not re-derive A from the grant table (several key homes can match one
 * selector, and §6.3 disambiguates them by the A chosen at launch), so the
 * pane row carries it: NULL on every direct (M1) pane, the A node id on every
 * relay pane. Immutable by construction (it joins the omit-list of the row
 * update shape), because no later act rewrites which machine authorized the
 * connection it opened with.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").addColumn("key_home_node_id", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("key_home_node_id").execute();
}
