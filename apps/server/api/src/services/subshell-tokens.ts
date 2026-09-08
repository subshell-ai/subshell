import type { CreatedApiKey, SubshellKeyMetadata } from "@/auth/apikey-store.js";
import { setApiKeyEnabled, setApiKeyExpiry } from "@/auth/apikey-store.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { logger } from "@/utils/logger.js";

/** Per-subshell MCP token lifetime. Self-extension resets it; death revokes it. */
const SUBSHELL_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days (plugin min is 1 day)

/**
 * Mints the per-subshell MCP API key: a better-auth api-key bound to the
 * subshell via `metadata.subshellId`, its id recorded on the subshell row for
 * deterministic revoke/extend. Returns the plaintext key ONCE (injected into
 * the subshell's env; never stored server-side in the clear — the plugin
 * hashes it).
 *
 * @param subshellId - the subshell this token authenticates
 * @param userId - owning user (the api-key reference)
 */
export async function issueSubshellToken(subshellId: string, userId: string): Promise<string> {
  const metadata: SubshellKeyMetadata = { kind: "subshell", subshellId };
  const created = (await getAuth().api.createApiKey({
    body: {
      name: `sess:${subshellId}`,
      userId,
      expiresIn: SUBSHELL_TOKEN_TTL_SECONDS,
      metadata,
      // Least-privilege grants every subshell token carries; a fresh object
      // per call because the plugin treats it as mutable.
      permissions: { channels: ["read", "write"], subshells: ["read", "write"] },
    },
  })) as unknown as CreatedApiKey;
  await new SubshellsRepository(db).update(subshellId, { apiKeyId: created.id });
  return created.key;
}

/**
 * Revokes a subshell's token (disable, not delete — the audit row survives).
 * No-op when the subshell never got a token or it is already revoked.
 *
 * @param subshellId - the subshell whose token to revoke
 */
export async function revokeSubshellToken(subshellId: string): Promise<void> {
  const row = await new SubshellsRepository(db).findById(subshellId);
  if (!row?.apiKeyId) return;
  setApiKeyEnabled(row.apiKeyId, false);
  logger.info(`subshell token revoked: ${subshellId}`);
}

/**
 * Pushes a subshell token's expiry out to a fresh TTL (self-extension for long
 * tasks). Returns false when the subshell has no token. A revoked token is
 * re-armed here ONLY if the caller still controls a live subshell row — the
 * route enforces that this is called for the caller's OWN subshell.
 *
 * @param subshellId - the subshell whose token to extend
 */
export async function extendSubshellToken(subshellId: string): Promise<boolean> {
  const row = await new SubshellsRepository(db).findById(subshellId);
  if (!row?.apiKeyId) return false;
  setApiKeyExpiry(row.apiKeyId, new Date(Date.now() + SUBSHELL_TOKEN_TTL_SECONDS * 1000).toISOString());
  return true;
}

/** The TTL the service stamps on new/extended tokens (for the route's response). */
export const subshellTokenTtlSeconds = (): number => SUBSHELL_TOKEN_TTL_SECONDS;
