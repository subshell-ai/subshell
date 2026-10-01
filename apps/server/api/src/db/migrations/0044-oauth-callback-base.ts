import type { Kysely } from "kysely";

/** Legacy entry lists no longer pin callbacks; null follows APP_BASE_URL. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("authProviders").addColumn("callbackBaseUrl", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("authProviders").dropColumn("callbackBaseUrl").execute();
}
