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
 * `dropColumn` without the missing-column failure.
 *
 * Kysely 0.29's `DropColumnBuilder` has no `ifExists()`, and this file's whole
 * safety story is that BOTH halves re-run cleanly, so the column's existence
 * is asked of SQLite directly (0026's helper, copied because migrations are
 * self-contained).
 */
async function dropColumnIfPresent(db: Kysely<any>, table: string, column: string): Promise<void> {
  if (!(await hasColumn(db, table, column))) {
    return;
  }
  await db.schema.alterTable(table).dropColumn(column).execute();
}

/**
 * Profiles become presets (spec 2026-09-13 §6): the row sheds the two columns
 * the Default-seeding and the node pin needed, and `subshells` re-points at
 * it through a nullable `preset_id` — "no preset" is a real launch now, and
 * the column's nullability is that fact in the schema.
 *
 * - `profiles` → `presets`: no FK anywhere references the table, so a plain
 *   RENAME carries `workspace_panes`-style cascade concerns nowhere.
 * - Its index is re-created under the new name (SQLite has no index rename).
 * - `is_default` dies with the seeding it protected; `node_id` dies with the
 *   pin (launch precedence is body → local → single-online-agent now).
 * - On `subshells`: ADD `preset_id` → copy `profile_id` → DROP `profile_id`.
 *   NEVER a table rebuild — `workspace_panes.subshell_id` and
 *   `subshell_shares.subshell_id` cascade on `subshells.id`, and
 *   `PRAGMA foreign_keys` cannot be disabled inside the migrator's
 *   transaction. ADD→UPDATE→DROP keeps those FKs untouched.
 *
 * Every step is guarded on the object's existence because test suites hand-
 * build PARTIAL schemas (0019's reasoning); the guards make this migration a
 * no-op for schema a given database never had. Production runs see every
 * guard pass, and `up` twice lands on the same schema.
 */
export async function up(db: Kysely<any>): Promise<void> {
  if ((await hasTable(db, "profiles")) && !(await hasTable(db, "presets"))) {
    await db.schema.alterTable("profiles").renameTo("presets").execute();
  }
  await db.schema.dropIndex("idx_profiles_user_harness").ifExists().execute();
  if (await hasTable(db, "presets")) {
    await db.schema
      .createIndex("idx_presets_user_harness")
      .ifNotExists()
      .on("presets")
      .columns(["user_id", "harness_id"])
      .execute();
    await dropColumnIfPresent(db, "presets", "is_default");
    await dropColumnIfPresent(db, "presets", "node_id");
  }
  if ((await hasColumn(db, "subshells", "profile_id")) && !(await hasColumn(db, "subshells", "preset_id"))) {
    await db.schema.alterTable("subshells").addColumn("preset_id", "text").execute();
    await sql`UPDATE subshells SET preset_id = profile_id`.execute(db);
    await db.schema.alterTable("subshells").dropColumn("profile_id").execute();
  }
}

/**
 * Back to profiles + the pin + the flag + `subshells.profile_id`.
 *
 * Two losses are documented rather than papered over. `subshells.preset_id`
 * is nullable and `profile_id` was NOT NULL, so a subshell launched without a
 * preset has no honest downgrade value — it gets `''` (the column is restored
 * NOT NULL DEFAULT '' exactly as 0001 would not have written it; a downgrade
 * of a post-presets row that had no preset simply names no row). And
 * `is_default` cannot be re-derived: the flag's meaning was "the seeder made
 * this row", and nothing downstream of `up` records that any more, so every
 * downgraded row comes back deletable (0).
 */
export async function down(db: Kysely<any>): Promise<void> {
  if ((await hasColumn(db, "subshells", "preset_id")) && !(await hasColumn(db, "subshells", "profile_id"))) {
    await db.schema
      .alterTable("subshells")
      .addColumn("profile_id", "text", (col) => col.notNull().defaultTo(""))
      .execute();
    await sql`UPDATE subshells SET profile_id = COALESCE(preset_id, '')`.execute(db);
    await db.schema.alterTable("subshells").dropColumn("preset_id").execute();
  }
  if ((await hasTable(db, "presets")) && !(await hasTable(db, "profiles"))) {
    await db.schema.alterTable("presets").renameTo("profiles").execute();
  }
  if (await hasTable(db, "profiles")) {
    if (!(await hasColumn(db, "profiles", "is_default"))) {
      await db.schema
        .alterTable("profiles")
        .addColumn("is_default", "integer", (col) => col.notNull().defaultTo(0))
        .execute();
    }
    if (!(await hasColumn(db, "profiles", "node_id"))) {
      await db.schema.alterTable("profiles").addColumn("node_id", "text").execute();
    }
  }
  await db.schema.dropIndex("idx_presets_user_harness").ifExists().execute();
  if (await hasTable(db, "profiles")) {
    await db.schema
      .createIndex("idx_profiles_user_harness")
      .ifNotExists()
      .on("profiles")
      .columns(["user_id", "harness_id"])
      .execute();
  }
}
