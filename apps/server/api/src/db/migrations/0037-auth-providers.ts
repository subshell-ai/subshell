import { type Kysely, sql } from "kysely";

/**
 * `auth_providers` — the admin-managed sign-in door table (spec 2026-09-24 §2).
 *
 * camelCase identifiers below: the app migrator's handle carries the
 * CamelCasePlugin, so every physical column is snake_case (pinned by test).
 * `registration_enabled` is NULLABLE and NULL means "legacy dynamic": open iff
 * no real account exists — the exact decision table the old `allow_registrations`
 * settings row had. A static default would have frozen the first-run window
 * open (§2, review finding 4); the seed row below therefore writes NULL, and
 * the migration COPIES the old settings row forward when one exists
 * (present-true ⇒ 1, anything else — false or corrupt — ⇒ 0, fail-closed).
 *
 * `endpoints_json` holds the discovery-resolved {authorizationUrl,tokenUrl,
 * userInfoUrl} captured at save time; rebuilds never re-fetch a dead issuer.
 * `entry_origins` is a JSON array of origins; position 0 is canonical (§5a).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("authProviders")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("issuer", "text")
    .addColumn("clientId", "text")
    .addColumn("clientSecret", "text")
    .addColumn("endpointsJson", "text")
    .addColumn("entryOrigins", "text")
    .addColumn("allowedDomains", "text")
    .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("signInEnabled", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("registrationEnabled", "integer")
    .addColumn("requireApproval", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("position", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("createdAt", "text", (c) => c.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updatedAt", "text", (c) => c.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db
    .insertInto("authProviders")
    .values({ id: "email", kind: "email", name: "E-mail", position: 0, entryOrigins: null })
    .execute();

  // Copy the old gate's meaning forward, upgrade-path only. Raw sql: this
  // bypasses the plugin, so the physical names are spelled directly.
  const old = await sql<{ value: string }>`
    SELECT value FROM settings WHERE key = 'allow_registrations'
  `.execute(db);
  if (old.rows.length > 0) {
    let open = 0;
    try {
      open = (JSON.parse(old.rows[0].value) as unknown) === true ? 1 : 0;
    } catch {
      open = 0; // corrupt ⇒ closed, same rule registrationDecision applied
    }
    await sql`UPDATE auth_providers SET registration_enabled = ${open} WHERE id = 'email'`.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("authProviders").execute();
}
