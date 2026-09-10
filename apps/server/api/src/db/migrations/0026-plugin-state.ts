import type { Kysely } from "kysely";

/**
 * The instance-level `enabled` flag for plugins (spec 2026-09-10 §6.1).
 *
 * This file carries the CREATE half of the ownership move (Task 9: the gate
 * needs the table the moment the instance route can answer PATCH). Task 10
 * adds the DROP half here — the per-node mirror columns on `nodes` — because
 * they are one change of ownership, not two migrations.
 *
 * `plugin_id` is the PK and an ABSENT ROW MEANS ENABLED: installing writes
 * nothing, the default is on, and the table never needs backfilling when a
 * plugin lands. Only an explicit disable (and, since the PATCH writes the row
 * both ways, an explicit re-enable) puts a row here.
 *
 * The flag deliberately does NOT live in `install.json`: the installer
 * rewrites that sidecar on every install, so a flag there is silently lost on
 * update — the trap §2.4 of the superseded phase-5 spec found for node
 * settings, met head-on here by putting the state in the database instead.
 *
 * `up` is idempotent (`ifNotExists`) so Task 10's extended file re-running
 * against a database that already applied this half is a clean no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("plugin_state")
    .ifNotExists()
    .addColumn("plugin_id", "text", (col) => col.primaryKey())
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("plugin_state").ifExists().execute();
}
