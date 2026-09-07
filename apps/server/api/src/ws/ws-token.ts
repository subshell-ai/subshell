import { randomBytes } from "node:crypto";

/**
 * Short-lived WebSocket attach tokens.
 *
 * The frontend calls an authenticated API endpoint to obtain a token (its
 * HttpOnly cookie works for REST), then passes it as the `token` query param
 * on the WS connection. Tokens are single-use and expire after 30 seconds,
 * so they can't be replayed.
 */
const TOKEN_TTL_MS = 30_000;

interface TokenEntry {
  userId: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();

/** Issues a single-use WS token for a user. */
export function issueWsToken(userId: string): string {
  const token = randomBytes(24).toString("base64url");
  tokens.set(token, { userId, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

/**
 * Validates + consumes a WS token. Returns the user id or null.
 * Tokens are invalidated on first use and after 30s.
 */
export function consumeWsToken(token: string): string | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  tokens.delete(token);
  if (Date.now() > entry.expiresAt) return null;
  return entry.userId;
}

/** Clears expired tokens (called periodically; mostly a memory trim). */
export function sweepWsTokens(): void {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (now > entry.expiresAt) tokens.delete(token);
  }
}
