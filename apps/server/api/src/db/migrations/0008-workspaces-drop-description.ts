import type { Kysely } from "kysely";

/**
 * Drops `workspaces.description`.
 *
 * The field shipped with an inline editor for one release and met its first
 * real user zero times: a workspace is named by the sessions tiled inside
 * it, and a prose blurb under that competes with the session count for the
 * one line of metadata worth showing.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("workspaces").dropColumn("description").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("workspaces").addColumn("description", "text").execute();
}
