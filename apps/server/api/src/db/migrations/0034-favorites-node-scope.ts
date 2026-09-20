import { type Kysely, sql } from "kysely";

/**
 * Favorites join recents on the node axis.
 *
 * The folder picker browses one machine at a time, and a starred path means
 * something only ON the machine whose filesystem holds it: `/home/dev/api`
 * starred while browsing Box is a shortcut to Box's directory, and it has no
 * business appearing in the local panel — the same dead click the picker
 * refused by HIDING the star on remote rows (2026-09-14). The fix is not the
 * hiding; it is the scoping. `recent_paths` grew its `node_id` in 0017 the
 * same way — a plain TEXT column defaulting to `local`, with the unique key
 * rebuilt to carry the dimension — and favorites copy that shape exactly,
 * including the no-FK choice: a deleted node's star rows are inert strings
 * in the plane's own table, and cascading would delete a person's favorites
 * because a machine was unenrolled and re-added.
 *
 * Existing rows keep working untouched: they ARE local paths, and the column
 * default stamps them so.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("favorites")
    .addColumn("node_id", "text", (col) => col.notNull().defaultTo("local"))
    .execute();

  await db.schema.dropIndex("idx_favorites_user_kind_ref").execute();
  await db.schema
    .createIndex("idx_favorites_user_kind_node_ref")
    .on("favorites")
    .columns(["user_id", "node_id", "kind", "ref"])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_favorites_user_kind_node_ref").execute();
  // Two statements, in this order, because the index about to be re-created
  // is UNIQUE on (user, kind, ref) and a node-scoped world can hold one path
  // starred on two machines: first the rows that mean "a favorite of a
  // machine this schema can no longer name" go entirely, then the collapse
  // de-duplicates what remains the way 0017's did (lowest id survives).
  await sql`DELETE FROM favorites WHERE node_id <> 'local'`.execute(db);
  await sql`
    DELETE FROM favorites
    WHERE id NOT IN (SELECT MIN(id) FROM favorites GROUP BY user_id, kind, ref)
  `.execute(db);
  await db.schema
    .createIndex("idx_favorites_user_kind_ref")
    .on("favorites")
    .columns(["user_id", "kind", "ref"])
    .unique()
    .execute();
  await db.schema.alterTable("favorites").dropColumn("node_id").execute();
}
