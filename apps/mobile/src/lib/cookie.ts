/**
 * Session-cookie plumbing for a non-browser client.
 *
 * better-auth names its cookie by the instance's scheme:
 * `better-auth.session_token` over http, `__Secure-better-auth.session_token`
 * over https — **the same token, a different name**. Getting this wrong is not
 * hypothetical: `apps/server/src/lib/session-cookie.ts:1-12` records an
 * incident on the TLS-terminated proxy where sign-in returned 200 and every
 * guarded route then 401ed, because extraction was hardcoded to one spelling.
 *
 * The backend now accepts either name on its own `/api/*` routes, and passes
 * BOTH to better-auth internally (`resolveCookieSession`). This client does the
 * same thing rather than guessing a name from the scheme: sending both is
 * correct on http, https, and plain-HTTP LAN origins with no branching.
 *
 * That still matters for better-auth's own endpoints (`/api/auth/sign-out`,
 * `get-session`), which are served by better-auth and read only the name its
 * baseURL implies — a client sending just the unprefixed cookie would 401 on
 * sign-out against an https instance.
 */

/** Cookie name used over http (and accepted everywhere by subshell's guard). */
export const SESSION_COOKIE = "better-auth.session_token";
/** Cookie name better-auth itself issues under an https baseURL. */
export const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;

/**
 * Builds the `Cookie` request header carrying the token under both spellings.
 * @param token - The session token from the sign-in response body
 * @returns A header value, or undefined when there is no token yet
 */
export function cookieHeader(token: string | null | undefined): string | undefined {
  if (!token) return undefined;
  return `${SESSION_COOKIE}=${token}; ${SECURE_SESSION_COOKIE}=${token}`;
}

/**
 * Pulls a rotated session token out of a response's `Set-Cookie` values.
 * better-auth rolls the token on refresh, so a client that only reads it at
 * sign-in will drift and start 401ing mid-use.
 * @param setCookies - Raw `Set-Cookie` header values (already a list)
 * @returns The new token value, or undefined when no session cookie was set
 */
export function tokenFromSetCookie(setCookies: readonly string[]): string | undefined {
  for (const line of setCookies) {
    const [pair] = line.split(";");
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== SESSION_COOKIE && name !== SECURE_SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    // An empty or cleared cookie means sign-out, not a rotation.
    if (!value || value === "undefined" || value === "null") continue;
    return value;
  }
  return undefined;
}
