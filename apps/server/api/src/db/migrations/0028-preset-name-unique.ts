import { type Kysely, sql } from "kysely";

/** True when the named table exists in this database. */
async function hasTable(db: Kysely<any>, name: string): Promise<boolean> {
  const r = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(
    db,
  );
  return r.rows.length > 0;
}

/**
 * A preset name becomes UNIQUE per (user, harness), case-insensitively.
 *
 * `0001-init.ts` documented the invariant and never enforced it: the index it
 * created covers `(user_id, harness_id)` only. The gap produced a real bug —
 * `create_subshell` resolved a preset by NAME with `find()`, so a tie launched
 * whichever row sorted first, and launching the wrong preset writes the wrong
 * credential layer. That call site was fixed to refuse ties; this closes the
 * hole underneath it, and it matches how the other user-scoped label in the
 * product already behaves (`0006-workspaces.ts` — unique `(user_id, name)`,
 * 409 from the service).
 *
 * **NOCASE, not the default binary collation.** Both surfaces that address a
 * preset by name already fold case — the MCP lookup lowercases, and a picker
 * showing "Dev" beside "DEV" asks a human to tell them apart by capital
 * letters. A binary-collated index would allow exactly that pair and leave
 * the product no better than it was.
 *
 * **Duplicates are RENAMED, never deleted.** An index creation that fails on
 * existing rows would brick a boot on any database that already holds a pair,
 * and a preset is a user's saved work — the oldest row keeps the name and the
 * rest take " (2)", " (3)" in `created_at` order. Suffixing can itself
 * collide with a literal "Dev (2)" someone typed, so it loops until the name
 * is free rather than assuming one pass is enough.
 */
export async function up(db: Kysely<any>): Promise<void> {
  if (!(await hasTable(db, "presets"))) return;

  // Oldest row of each colliding group keeps its name; `rn` numbers the rest
  // from 2, which is also the first suffix they are offered.
  const dupes = await sql<{ id: string; userId: string; harnessId: string; name: string; rn: number }>`
    SELECT id, user_id AS "userId", harness_id AS "harnessId", name, rn FROM (
      SELECT id, user_id, harness_id, name,
             ROW_NUMBER() OVER (
               PARTITION BY user_id, harness_id, name COLLATE NOCASE
               ORDER BY created_at, id
             ) AS rn
      FROM presets
    ) WHERE rn > 1
  `.execute(db);

  for (const row of dupes.rows) {
    let suffix = row.rn;
    let candidate = `${row.name} (${suffix})`;
    // The suffixed name must be free too — against the whole table as it
    // stands, which includes names this loop has already assigned.
    while (
      (
        await sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM presets
          WHERE user_id = ${row.userId} AND harness_id = ${row.harnessId} AND name = ${candidate} COLLATE NOCASE
        `.execute(db)
      ).rows[0].n > 0
    ) {
      suffix += 1;
      candidate = `${row.name} (${suffix})`;
    }
    await sql`UPDATE presets SET name = ${candidate} WHERE id = ${row.id}`.execute(db);
  }

  // The old `(user_id, harness_id)` index is a strict PREFIX of the new one,
  // so SQLite can serve every lookup it served; keeping both would be a
  // second index to maintain on every write for no read it answers alone.
  await db.schema.dropIndex("idx_presets_user_harness").ifExists().execute();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_presets_user_harness_name
    ON presets (user_id, harness_id, name COLLATE NOCASE)
  `.execute(db);
}

/**
 * Back to a non-unique lookup index. The renames are NOT undone: "Dev (2)" is
 * a real name a user may have kept working with by the time anyone downgrades,
 * and reversing it would need a record of what collided, which this migration
 * deliberately does not keep. A downgrade returns the schema, not the data.
 */
export async function down(db: Kysely<any>): Promise<void> {
  if (!(await hasTable(db, "presets"))) return;
  await db.schema.dropIndex("idx_presets_user_harness_name").ifExists().execute();
  await db.schema
    .createIndex("idx_presets_user_harness")
    .ifNotExists()
    .on("presets")
    .columns(["user_id", "harness_id"])
    .execute();
}
