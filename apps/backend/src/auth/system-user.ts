import { authDatabase } from "@/auth/database.js";
import { logger } from "@/utils/logger.js";

/** Email of the dedicated service user that owns admin-managed system keys. */
export const SYSTEM_USER_EMAIL = "system@mote.local";

let cachedId: string | null = null;

/**
 * Ensures the `system` service user exists and returns its id (the owner for
 * system API keys). The account is intentionally unusable for login: it gets
 * a random password, no credential account row, and emailVerified = false.
 *
 * Raw SQL on the auth handle because better-auth's physical columns are
 * camelCase and the app's Kysely instance would rename them via its
 * CamelCasePlugin (the trap documented in api/__tests__/helpers/auth-tables.ts).
 */
export async function ensureSystemUser(): Promise<string> {
  if (cachedId) return cachedId;
  const db = authDatabase();
  const row = db.prepare<{ id: string }, [string]>(`SELECT id FROM "user" WHERE email = ?`).get(SYSTEM_USER_EMAIL);
  if (row) {
    cachedId = row.id;
    return row.id;
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // No credential account row is created for this id, so there is simply no
  // way to sign in as it — no password exists, verifiable or otherwise.
  db.run(
    `INSERT INTO "user" (id, name, email, emailVerified, image, "createdAt", "updatedAt")
     VALUES (?, 'system', ?, 0, NULL, ?, ?)`,
    [id, SYSTEM_USER_EMAIL, now, now],
  );
  cachedId = id;
  logger.info(`system service user created: ${id}`);
  return id;
}
