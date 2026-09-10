import { type Kysely, sql } from "kysely";

/**
 * Drops `harness_plugins` (spec 2026-09-09 §12).
 *
 * The last of the enable state. The table held a per-instance on/off flag for
 * each harness on the control-plane host, and it was the reason `local` was
 * the one node resolved differently from every other: an enable table here, a
 * plugins directory everywhere else. `local` has a plugins directory now
 * (`<SUBSHELL_SERVER_DATA_DIR>/plugins/`), so what it OFFERS is what it has
 * installed, exactly as on an agent. Nothing reads these rows.
 *
 * **The rows are not read before being dropped.** The original plan had a
 * one-way seeding step that would install a built-in for each harness that had
 * been enabled and installed here. That exists to carry installs predating the
 * plugins directory, and there are none: nothing is deployed. Seeding installs
 * the built-ins outright instead, keyed on the directory not existing yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("harness_plugins").ifExists().execute();
}

/**
 * Recreates the empty table, with the columns `0001-init` gave it.
 *
 * Empty, and it cannot be otherwise: the rows said which harnesses an operator
 * had switched on, and nothing left in the schema records that. Reconstructing
 * them from the plugin report would assert that every installed plugin had
 * been deliberately enabled, which is a different claim and one this migration
 * has no evidence for. A downgrade lands on the lazy default (an absent row
 * means the plugin's own `enabledByDefault`), which is where a fresh install
 * started anyway.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("harness_plugins")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();
}
