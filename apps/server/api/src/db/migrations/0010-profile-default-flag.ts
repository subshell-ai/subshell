import type { Kysely } from "kysely";

/**
 * Default profiles become unremovable: a flag, not a name. The auto-seeding
 * (services/default-profiles.ts) marks every row it creates `is_default = 1`;
 * DELETE /api/profiles/:id refuses those. A flag rather than a name match so
 * renaming a Default keeps it protected — and a hand-made profile that
 * happens to be called "Default" is not.
 *
 * The backfill adopts rows the seeder created before the flag existed — the
 * seeder's COMPLETE blank shape, every configurable field at its inserted
 * value. Loose conditions would false-positive: POST /api/profiles stores
 * omitted optional fields as NULL, so a hand-made "Default" that set a
 * description, isolation, or restart policy but skipped the JSON blobs must
 * stay deletable. Under-adoption is harmless (a pair that later drops to zero
 * profiles re-seeds at the next boot); over-adoption strands a hand-made row
 * under a flag nothing can clear (PUT's body has no isDefault field).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("profiles")
    .addColumn("is_default", "integer", (c) => c.notNull().defaultTo(0))
    .execute();

  await db
    .updateTable("profiles")
    .set({ is_default: 1 })
    .where("name", "=", "Default")
    .where("description", "is", null)
    .where("env_json", "is", null)
    .where("flags_json", "is", null)
    .where("settings_json", "is", null)
    .where("config_isolation", "=", 0)
    .where("restart_on_exit", "=", 0)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("profiles").dropColumn("is_default").execute();
}
