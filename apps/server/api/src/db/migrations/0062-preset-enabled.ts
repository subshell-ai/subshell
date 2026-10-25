import { type Kysely, sql } from "kysely";

/** True when the named table exists in this database. */
async function hasTable(db: Kysely<any>, name: string): Promise<boolean> {
  const r = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(
    db,
  );
  return r.rows.length > 0;
}

/** True when the named table has the named column. */
async function hasColumn(db: Kysely<any>, table: string, column: string): Promise<boolean> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}`.execute(
    db,
  );
  return r.rows.length > 0;
}

/**
 * Preset enable/disable (spec 2026-10-24): an `enabled` flag on both preset
 * tables so a preset can be set aside without deleting it. 1 = offered; 0 =
 * hidden from every picker and refused at launch, while the `/presets` list
 * keeps the row so it can be re-enabled.
 *
 * The 0/1 representation matches the existing preset flag convention
 * (`restartOnExit`, `configIsolation`, `crossCommEnabled`). It is a LOCAL
 * preference — not a portable preset property — so the import/export file
 * format is unchanged and an imported preset always starts enabled (1).
 *
 * Every step is guarded on the TABLE and the column's existence, because test
 * suites hand-build PARTIAL schemas (0027's reasoning): a curated `:memory:`
 * database may hold `presets` but no `ssh_presets`, and `pragma_table_info`
 * answers an absent table with zero rows, so a column-only guard would read
 * "absent" and then `addColumn` would throw. The guards also make a re-run a
 * no-op. `down` drops the column from both, guarded symmetrically.
 */
export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ["presets", "ssh_presets"]) {
    if ((await hasTable(db, table)) && !(await hasColumn(db, table, "enabled"))) {
      await db.schema
        .alterTable(table)
        .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
        .execute();
    }
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ["presets", "ssh_presets"]) {
    if ((await hasTable(db, table)) && (await hasColumn(db, table, "enabled"))) {
      await db.schema.alterTable(table).dropColumn("enabled").execute();
    }
  }
}
