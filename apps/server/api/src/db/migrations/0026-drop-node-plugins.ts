import { type Kysely, sql } from "kysely";

/**
 * `dropColumn` without the missing-column failure.
 *
 * Kysely 0.29's `DropColumnBuilder` has no `ifExists()` (only tables do), and
 * this file's whole safety story is that BOTH halves re-run cleanly, so the
 * column's existence is asked of SQLite directly — the same question
 * `DROP COLUMN IF EXISTS` would ask, spelled for a builder that cannot.
 */
async function dropColumnIfPresent(db: Kysely<unknown>, table: string, column: string): Promise<void> {
  const present = await sql<{
    n: number;
  }>`SELECT count(*) AS n FROM pragma_table_info(${table}) WHERE name = ${column}`.execute(db);
  if ((present.rows[0]?.n ?? 0) === 0) {
    return;
  }
  await db.schema.alterTable(table).dropColumn(column).execute();
}

/**
 * The plugin ownership move, both halves in one migration (spec 2026-09-10 §6.1).
 *
 * One change of ownership, not two migrations: the per-node mirror goes and
 * the instance-level state arrives.
 *
 * **The DROP half.** `nodes.plugins_json` / `nodes.plugins_at` (0023) mirrored
 * each node's own report of the plugins it had installed, back when the node
 * owned that set. Plugins now live on the control plane (the inversion, spec
 * 2026-09-10): the instance's `<dataDir>/plugins/` directory is the one
 * installed set, resolved plane-side for every node alike, and the agent
 * holds no plugin concept at all. Nothing reads these columns since the
 * inventory module stopped branching on the mirror; the protocol no longer
 * carries a plugin report.
 *
 * **The CREATE half.** `plugin_state` is the instance-level `enabled` flag.
 * `plugin_id` is the PK and an ABSENT ROW MEANS ENABLED: installing writes
 * nothing, the default is on, and the table never needs backfilling when a
 * plugin lands. Only an explicit disable (and, since the PATCH writes the row
 * both ways, an explicit re-enable) puts a row here. The flag deliberately
 * does NOT live in `install.json`: the installer rewrites that sidecar on
 * every install, so a flag there is silently lost on update.
 *
 * This file was created as `0026-plugin-state` (Task 9, CREATE half only) and
 * extended here under its final name. No released database exists, so the
 * rename costs nothing, and both halves are idempotent (the create is
 * `ifNotExists`, the drops check `pragma_table_info` first) so a dev database
 * that recorded the old name — or anything that runs `up` twice — lands on
 * the same schema instead of hard-stopping at boot.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("plugin_state")
    .ifNotExists()
    .addColumn("plugin_id", "text", (col) => col.primaryKey())
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();
  await dropColumnIfPresent(db, "nodes", "plugins_json");
  await dropColumnIfPresent(db, "nodes", "plugins_at");
}

/**
 * Puts the mirror back EMPTY and drops `plugin_state`.
 *
 * Empty, and it cannot be otherwise (0025's reasoning, same shape): the
 * columns held each node's report of its installed set, and nothing left in
 * the downgraded schema — nor on the wire — records that any more.
 * Reconstructing them would fabricate reports no node made. A downgrade lands
 * on NULL ("never reported"), which is what a fresh row meant with the
 * columns present anyway. The `plugin_state` flag, by contrast, is genuinely
 * lost: `plugin_state` is what this schema has no equivalent of, and an
 * absent flag row downstream of a downgrade means every plugin's own
 * `enabledByDefault` again.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("nodes").addColumn("plugins_json", "text").execute();
  await db.schema.alterTable("nodes").addColumn("plugins_at", "text").execute();
  await db.schema.dropTable("plugin_state").ifExists().execute();
}
