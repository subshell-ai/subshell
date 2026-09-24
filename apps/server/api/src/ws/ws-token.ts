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
 *
 * The store is BOUNDED since the 2026-09-23 audit pass: those machine mints
 * run at script rates, and the only trim this Map had was a timer nobody's
 * writes bounded. {@link issueWsToken} refuses past
 * {@link MAX_PENDING_WS_TOKENS} with {@link WsTokenCapacityError} rather
 * than growing the process's memory on a caller's schedule.
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
 * Ceiling on OUTSTANDING tokens. Sits far above any honest load — a token
 * lives 30 s and is single-use, so 10 000 concurrent ones means hundreds of
 * attaches per second from one instance — while bounding the one in-memory
 * store a script-rate bearer mint can reach (audit 2026-09, item 8: the mint
 * became machine-reachable in #159 and the Map never grew a limit).
 */
export const MAX_PENDING_WS_TOKENS = 10_000;

/**
 * Thrown by {@link issueWsToken} when the store is full of LIVE tokens.
 * Carries `status = 503` like every other status-bearing class in this
 * codebase, so the global error handler turns the mint route's throw into an
 * honest "the server will not take more right now" without the route
 * reaching for `status()` itself.
 */
export class WsTokenCapacityError extends Error {
  readonly status = 503;
  constructor() {
    super("too many outstanding attach tokens");
    this.name = "WsTokenCapacityError";
  }
}

/** The live cap; {@link setWsTokenCapForTests} moves it for tests only. */
let cap = MAX_PENDING_WS_TOKENS;

/**
 * Issues a single-use WS token. Omit `subshellId` for the human (cookie)
 * path; a bearer mint MUST pass the subshell it is bound to — the binding
 * is enforced at every redemption, not merely intended.
 *
 * At the cap, expired entries are swept FIRST (a store full of dead tokens
 * must not refuse a mint), and only a still-full store after the sweep
 * throws {@link WsTokenCapacityError}.
 */
export function issueWsToken(userId: string, subshellId: string | null = null): string {
  if (tokens.size >= cap) {
    sweepWsTokens();
    if (tokens.size >= cap) throw new WsTokenCapacityError();
  }
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

/**
 * Remove every outstanding token minted for `userId`.
 *
 * The account-disable counterpart to the socket sweeps. Redemption consults
 * the store ALONE — `consumeWsToken` never re-asks whether the account is
 * still live — so a token minted inside its 30-second life moments before a
 * disable would, after the disable's socket sweep, re-create exactly the
 * attach the disable existed to end. Dropping the entries makes its
 * redemption fail like any unknown token's, which is also the honest refusal
 * SHAPE: a caller cannot tell "revoked by a disable" from "never existed".
 *
 * Scoped (Bearer-minted) tokens count too, and correctly so: a scoped entry
 * records the SUBSHELL'S OWNER as its identity (see {@link TokenEntry}), so
 * the tokens this drops are exactly the ones that would attach AS the
 * disabled user — including a machine-key attach bound to one of their panes.
 *
 * Expired entries for the user are removed by the same walk but not counted:
 * they were already refusing redemption, and counting them would inflate the
 * audit line for a revocation that revoked nothing.
 *
 * @param userId - whose outstanding tokens to destroy
 * @returns how many LIVE tokens were removed, for the audit line
 */
export function dropUserTokensFor(userId: string): number {
  const now = Date.now();
  let revoked = 0;
  for (const [token, entry] of tokens) {
    if (entry.userId !== userId) continue;
    tokens.delete(token);
    if (now <= entry.expiresAt) revoked++;
  }
  return revoked;
}

/**
 * Moves the outstanding-token cap for tests. `null` restores
 * {@link MAX_PENDING_WS_TOKENS}. Returns the previous cap so a test can
 * restore it without knowing the production number.
 * @internal
 */
export function setWsTokenCapForTests(next: number | null): number {
  const previous = cap;
  cap = next ?? MAX_PENDING_WS_TOKENS;
  return previous;
}

/**
 * Empties the token store outright (the periodic sweep only drops EXPIRED
 * ones, which would leave a capped test's live tokens across file
 * boundaries). Pairs with {@link setWsTokenCapForTests} in an `afterEach`.
 * @internal
 */
export function clearWsTokensForTests(): void {
  tokens.clear();
}
