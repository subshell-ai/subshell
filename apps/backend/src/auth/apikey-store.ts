import { authDatabase } from "@/auth/database.js";

/**
 * The one owner of raw SQL against better-auth's `apikey` table and of the
 * `metadata.kind` vocabulary that discriminates the two bearer kinds.
 *
 * Why raw SQL: the `@better-auth/api-key` plugin's update/list/delete
 * endpoints are session-guarded and unusable server-side (spike finding) —
 * see also {@link ensureSystemUser} for the same raw-handle pattern. Column
 * names are better-auth's physical camelCase, which the app's Kysely
 * CamelCasePlugin would mangle; hence this module, on the auth handle.
 *
 * Why the metadata contract lives here: both key kinds share one table and
 * only `metadata.kind` tells them apart. Mint sites (session-tokens, the
 * system-keys route) and the guard's kind check all import these names, so
 * a rename is a one-file change instead of a cross-file grep.
 */

/** The two kinds of bearer key this app mints. */
export type ApiKeyKind = "session" | "system";

/** metadata payload for a per-session token. */
export interface SessionKeyMetadata {
  kind: "session";
  /** The session this token authenticates as. */
  sessionId: string;
}

/** metadata payload for an admin-managed system key. */
export interface SystemKeyMetadata {
  kind: "system";
}

/** The subset of the plugin's createApiKey return shape this app reads. */
export interface CreatedApiKey {
  /** Key row id (for later enable/disable/delete). */
  id: string;
  /** Plaintext key — returned once by the plugin; only its hash is stored. */
  key: string;
}

/** Row shape the apikey table yields for the admin list (never the hash). */
export interface ApiKeyListRow {
  id: string;
  name: string;
  /** Non-secret start of the key, for identification. */
  start: string | null;
  /** SQLite integer 0/1. */
  enabled: number;
  createdAt: string;
  expiresAt: string | null;
}

/**
 * SQL scoping system keys apart from session tokens. json_extract (not a
 * LIKE on the serialized form) so a change in better-auth's metadata
 * whitespace or key ordering can never silently un-scope the admin surface
 * — a key that fails to match here would stop being disable-able while still
 * authenticating at full access.
 */
const SYSTEM_KIND_SQL = `json_extract(metadata, '$.kind') = 'system'`;

/** Enables or disables a key by id (disable revokes the bearer immediately). */
export function setApiKeyEnabled(id: string, enabled: boolean): void {
  authDatabase().run(`UPDATE apikey SET enabled = ?, "updatedAt" = ? WHERE id = ?`, [
    enabled ? 1 : 0,
    new Date().toISOString(),
    id,
  ]);
}

/** Pushes a key's expiry to a new timestamp (ISO 8601). */
export function setApiKeyExpiry(id: string, expiresAtIso: string): void {
  authDatabase().run(`UPDATE apikey SET "expiresAt" = ?, "updatedAt" = ? WHERE id = ?`, [
    expiresAtIso,
    new Date().toISOString(),
    id,
  ]);
}

/** Removes a key row entirely. */
export function deleteApiKey(id: string): void {
  authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [id]);
}

/** All system-kind keys owned by `systemUserId`, newest first. */
export function listSystemKeys(systemUserId: string): ApiKeyListRow[] {
  return authDatabase()
    .prepare<ApiKeyListRow, [string]>(
      `SELECT id, name, start, enabled, "createdAt", "expiresAt"
       FROM apikey
       WHERE "referenceId" = ? AND ${SYSTEM_KIND_SQL}
       ORDER BY "createdAt" DESC`,
    )
    .all(systemUserId);
}

/** True when `id` is a live system-kind key (PATCH/DELETE scoping). */
export function isSystemKey(id: string, systemUserId: string): boolean {
  const row = authDatabase()
    .prepare<{ id: string }, [string, string]>(
      `SELECT id FROM apikey WHERE id = ? AND "referenceId" = ? AND ${SYSTEM_KIND_SQL}`,
    )
    .get(id, systemUserId);
  return row !== null;
}
