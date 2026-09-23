import { randomBytes } from "node:crypto";

/**
 * Short-lived WebSocket attach tokens.
 *
 * The frontend calls an authenticated API endpoint to obtain a token (its
 * HttpOnly cookie works for REST), then passes it as the `token` query param
 * on the WS connection. Tokens are single-use and expire after 30 seconds,
 * so they can't be replayed.
 *
 * Machine credentials may mint tokens too (`POST /api/auth/ws-token` under a
 * Bearer key), but only SCOPED ones: `subshellId` is set at issue time and
 * every redemption site must honour the binding — `attach-resolve` refuses
 * the token on any other subshell, and `/ws/live` refuses scoped tokens
 * outright. That is what keeps a bearer credential's WS reach to the one
 * pane its holder was allowed to name, and off the whole-user live feed.
 */
const TOKEN_TTL_MS = 30_000;

interface TokenEntry {
  /**
   * The identity the attach resolves ACCESS AS — not necessarily whoever
   * minted it. A cookie mint stores the session's own user; a bearer mint
   * stores the TARGET SUBSHELL'S OWNER (the system service user holds no
   * admin role and no shares, so recording the actor would resolve every
   * machine attach to access `none`). This is safe ONLY because of the
   * binding below: a scoped token can ever attach to the one pane whose
   * owner it names. Do not loosen either half.
   */
  userId: string;
  /**
   * The subshell this token may attach to, or `null` for an unscoped
   * human (cookie) token — the SPA and mobile, which attach wherever the
   * session's access allows, exactly as they always have.
   */
  subshellId: string | null;
  expiresAt: number;
}

/** What a redeemed token resolves to: who the socket acts as, and its scope. */
export interface WsTokenIdentity {
  userId: string;
  subshellId: string | null;
}

const tokens = new Map<string, TokenEntry>();

/**
 * Issues a single-use WS token. Omit `subshellId` for the human (cookie)
 * path; a bearer mint MUST pass the subshell it is bound to — the binding
 * is enforced at every redemption, not merely intended.
 */
export function issueWsToken(userId: string, subshellId: string | null = null): string {
  const token = randomBytes(24).toString("base64url");
  tokens.set(token, { userId, subshellId, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

/**
 * Validates + consumes a WS token. Returns the identity (user + scope) or
 * null. Tokens are invalidated on first use and after 30s.
 */
export function consumeWsToken(token: string): WsTokenIdentity | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  tokens.delete(token);
  if (Date.now() > entry.expiresAt) return null;
  return { userId: entry.userId, subshellId: entry.subshellId };
}

/** Clears expired tokens (called periodically; mostly a memory trim). */
export function sweepWsTokens(): void {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (now > entry.expiresAt) tokens.delete(token);
  }
}
