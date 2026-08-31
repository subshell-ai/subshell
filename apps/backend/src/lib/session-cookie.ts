import type { Session, User } from "better-auth";
import { auth } from "@/auth.js";

/**
 * better-auth's session cookie name under an http baseURL. Over https it
 * issues `__Secure-better-auth.session_token` instead — the SAME token, a
 * different name — and `auth.api.getSession` looks the cookie up under
 * exactly the name its own baseURL implies. Code that extracts the token by
 * one hardcoded name therefore 401s on every TLS-terminated deployment
 * (incident: the mote.ein.disaresta.com proxy, 2026-08-31 — sign-in 200s
 * because better-auth reads both spellings, guarded routes 401).
 */
export const SESSION_COOKIE = "better-auth.session_token";
export const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;

/**
 * Pulls the session token out of a raw `Cookie` header, accepting either
 * cookie spelling. First match wins, like a cookie store would.
 * @param cookieHeader - The verbatim `Cookie` request header ("" is fine)
 * @returns The (still URL-encoded) token value, or undefined when absent
 */
export function extractSessionToken(cookieHeader: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE || k === SECURE_SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}

/** The user+session pair behind a valid session cookie. */
export interface CookieSession {
  /** The better-auth session row. */
  session: Session;
  /** Its owner. */
  user: User;
}

/**
 * Resolves the request's session-cookie credential, or null when there is
 * none valid.
 *
 * The token is re-presented to better-auth under BOTH cookie spellings:
 * whichever name this instance's baseURL implies is the one it reads, so
 * extraction stays correct under http, https, and tests alike. Only the
 * token is passed — never the caller's full headers — so the cookie cache
 * (`session_data`) can never answer route auth from a stale client copy;
 * route freshness stays DB-backed by design, see the comment in `auth.ts`.
 *
 * @param cookieHeader - The verbatim `Cookie` request header
 */
export async function resolveCookieSession(cookieHeader: string): Promise<CookieSession | null> {
  const token = extractSessionToken(cookieHeader);
  if (!token) return null;
  try {
    const result = await auth.api.getSession({
      headers: new Headers({
        cookie: `${SESSION_COOKIE}=${token}; ${SECURE_SESSION_COOKIE}=${token}`,
      }),
    });
    if (!result?.user || !result?.session) return null;
    return { user: result.user as User, session: result.session as Session };
  } catch {
    return null;
  }
}
