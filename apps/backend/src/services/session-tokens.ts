import type { CreatedApiKey, SessionKeyMetadata } from "@/auth/apikey-store.js";
import { setApiKeyEnabled, setApiKeyExpiry } from "@/auth/apikey-store.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { logger } from "@/utils/logger.js";

/** Per-session MCP token lifetime. Self-extension resets it; death revokes it. */
const SESSION_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days (plugin min is 1 day)

/**
 * Mints the per-session MCP API key: a better-auth api-key bound to the
 * session via `metadata.sessionId`, its id recorded on the session row for
 * deterministic revoke/extend. Returns the plaintext key ONCE (injected into
 * the session's env; never stored server-side in the clear — the plugin
 * hashes it).
 *
 * @param sessionId - the session this token authenticates
 * @param userId - owning user (the api-key reference)
 */
export async function issueSessionToken(sessionId: string, userId: string): Promise<string> {
  const metadata: SessionKeyMetadata = { kind: "session", sessionId };
  const created = (await auth.api.createApiKey({
    body: {
      name: `sess:${sessionId}`,
      userId,
      expiresIn: SESSION_TOKEN_TTL_SECONDS,
      metadata,
      // Least-privilege grants every session token carries; a fresh object
      // per call because the plugin treats it as mutable.
      permissions: { channels: ["read", "write"], sessions: ["read", "write"] },
    },
  })) as unknown as CreatedApiKey;
  await new SessionsRepository(db).update(sessionId, { apiKeyId: created.id });
  return created.key;
}

/**
 * Revokes a session's token (disable, not delete — the audit row survives).
 * No-op when the session never got a token or it is already revoked.
 *
 * @param sessionId - the session whose token to revoke
 */
export async function revokeSessionToken(sessionId: string): Promise<void> {
  const row = await new SessionsRepository(db).findById(sessionId);
  if (!row?.apiKeyId) return;
  setApiKeyEnabled(row.apiKeyId, false);
  logger.info(`session token revoked: ${sessionId}`);
}

/**
 * Pushes a session token's expiry out to a fresh TTL (self-extension for long
 * tasks). Returns false when the session has no token. A revoked token is
 * re-armed here ONLY if the caller still controls a live session row — the
 * route enforces that this is called for the caller's OWN session.
 *
 * @param sessionId - the session whose token to extend
 */
export async function extendSessionToken(sessionId: string): Promise<boolean> {
  const row = await new SessionsRepository(db).findById(sessionId);
  if (!row?.apiKeyId) return false;
  setApiKeyExpiry(row.apiKeyId, new Date(Date.now() + SESSION_TOKEN_TTL_SECONDS * 1000).toISOString());
  return true;
}

/** The TTL the service stamps on new/extended tokens (for the route's response). */
export const sessionTokenTtlSeconds = (): number => SESSION_TOKEN_TTL_SECONDS;
