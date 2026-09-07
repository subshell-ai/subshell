import { getMigrations } from "better-auth/db/migration";
import { authDatabase } from "@/auth/database.js";
import { AUTH_OPTIONS } from "@/auth.js";

/**
 * Creates better-auth's own tables (user/session/account/verification) on a
 * fresh database. Idempotent: it computes what's missing and only creates
 * those tables (existing app tables are left untouched).
 */
export async function runAuthMigrations(): Promise<void> {
  const db = authDatabase();
  // Full options (incl. plugins) so plugin tables (apikey) are created too.
  const migration = await getMigrations({ ...AUTH_OPTIONS, database: db, logger: { level: "error" } });
  await migration.runMigrations();
}
