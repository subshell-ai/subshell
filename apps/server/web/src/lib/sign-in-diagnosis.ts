/**
 * Why a sign-in that the server ACCEPTED can still leave you signed out
 * (operator's report, 2026-09-18).
 *
 * The reported symptom was "I change the base URL, close the app, reopen, and
 * I cannot sign in — change it back and I can", and separately "I still end up
 * on the sign in form after a brief transition". Both are one mechanism, and
 * none of it is a server failure: the POST returns 200, the browser DROPS the
 * cookie, and the redirect to `/` bounces straight back to `/login`.
 *
 * **better-auth derives cookie security from `APP_BASE_URL`, not from the
 * request.** Measured in 1.7.1 (`dist/cookies/index.mjs`): a `baseURL`
 * starting with `https://` sets `secure: true` AND prefixes the cookie name
 * `__Secure-`. Browsers refuse a `__Secure-` cookie that arrives over plain
 * `http`, so on an `http` origin the session cookie is discarded on receipt.
 *
 * That is ordinarily invisible, because a person browsing an https instance is
 * on https. It bites in exactly one place: **Subshell Server's own window loads
 * this machine over http** (`http://127.0.0.1:<port>` — that is what the app
 * opens it on, and it is the origin that window sits on unless a sign-in takes
 * it elsewhere). So the moment the instance's base URL becomes an https
 * address, the app's own window can never store a session again, while every
 * browser on the real address works fine.
 *
 * So the diagnosis is inferred from three facts the page already has, with no
 * new anonymous read (the sign-in page is pre-auth and `appBaseUrl` lives
 * behind `GET /api/settings/public`, which is not): the server accepted the
 * credentials, no session exists a moment later, and what kind of surface this
 * is.
 */

/**
 * What to say when the session check itself could not run.
 *
 * Its own sentence rather than a corner of {@link signInDiagnosis}, because it
 * is a different fact: `getSessionUser` throws on anything that is not a
 * 401/403 precisely so a failed read is never read as signed-out, and putting
 * the cookie diagnosis on screen for a dropped request would send someone to
 * change an address that works (review, 2026-09-18).
 */
export const SESSION_CHECK_FAILED = "Signed in, but this page could not check the session. Try again.";

/** What to tell someone whose accepted sign-in produced no session. */
export interface SignInDiagnosis {
  /** The sentence naming what happened. Never blames the credentials. */
  message: string;
  /**
   * The remedy, when this surface has one worth naming. Empty where the
   * honest answer is "this needs looking at" rather than a step.
   */
  remedy: string;
}

/**
 * The diagnosis for a sign-in the server accepted and the browser did not keep.
 *
 * @param opts.inServerApp - the page is inside Subshell Server's own window
 *   (`isServerDesktop()`), the window that app opens on this machine's loopback
 *   address
 * @param opts.protocol - `window.location.protocol`, e.g. `"http:"`
 */
export function signInDiagnosis(opts: { inServerApp: boolean; protocol: string }): SignInDiagnosis {
  const insecureOrigin = opts.protocol === "http:";
  if (opts.inServerApp && insecureOrigin) {
    // The one case this page can name precisely, because the window's origin
    // is fixed by the app rather than chosen by the reader.
    return {
      message:
        "Signed in, but this window could not store the session. This page is on http, and an instance whose base " +
        "URL is an https address marks its session cookies Secure, which a browser will not keep on an http page.",
      // **The remedy may not name a page that needs this session** (review,
      // 2026-09-18). It pointed at Server Settings → Networking, which is
      // exactly what cannot be reached: the premise of this branch is that no
      // session can be stored. The way back is the assistant's own Server
      // Addresses screen, which drives the CLI and needs no session — reached
      // from this app's tray menu, with the server up or down.
      remedy:
        "Open the instance in a browser at its https address to sign in there, or open Server Addresses from " +
        "Subshell Server's tray menu to point the base URL back at this machine.",
    };
  }
  if (insecureOrigin) {
    return {
      message:
        "Signed in, but this browser did not store the session. That happens when the instance's base URL is an " +
        "https address and this page is on http: the session cookie is marked Secure, and a Secure cookie is not " +
        "kept on an insecure page.",
      remedy: "Open this instance at the https address its base URL names.",
    };
  }
  // On https with no session, the cookie was refused for a reason this page
  // cannot see — a mismatched host, a cookie policy, a clock. Naming a remedy
  // here would be guessing, and a wrong remedy on a sign-in screen is worse
  // than none.
  return {
    message: "Signed in, but no session was stored. The server accepted the credentials and the session did not stick.",
    remedy: "",
  };
}

/**
 * What the login page makes of a failed OAuth round trip (spec 2026-09-24 §4).
 *
 * better-auth returns to `errorCallbackURL` (this page) with
 * `?error=<code>&error_description=<text>` appended; the provider policy's refusal
 * codes are stable wire strings, and two of them earn a special reading here.
 * Everything else is still RENDERED (final review, Important 2 — it used to
 * render nothing): a domain-gate, registration-closed or provider-closed refusal
 * and the provider's own message are the honest answer for that trip, and a
 * visitor back on a pristine login page with zero feedback after a full IdP
 * round trip was indistinguishable from a page that ignored their click.
 */
export type AuthErrorDecision =
  /** The identity exists but an admin has not approved it: leave for `/pending`. */
  | { kind: "pending"; email: string | null }
  /** A session could not be created and the honest line is the generic one. */
  | { kind: "generic"; message: string }
  /**
   * A refusal this page has no special reading for, but the trip really
   * carried a code: the sanitized sentence is what gets shown above the
   * provider block (`error_description` as TEXT, never as an address — that
   * reading belongs to `pending_approval` alone).
   */
  | { kind: "refused"; message: string }
  /** Nothing here maps: there was no round trip to report. */
  | { kind: "none" };

/**
 * The one sentence for every round trip that produced no session but cannot
 * say which provider policy refused it (spec §4's honest line, rewritten to two
 * sentences: UI copy carries no em dash).
 */
export const SIGN_IN_UNABLE =
  "Sign-in could not complete. Access may be pending approval or disabled, so contact an admin.";

/**
 * The fallback for a refusal this page does not interpret and the trip named
 * no description for.
 */
export const ROUND_TRIP_REFUSED = "That sign-in attempt was refused. Try again or contact an admin.";

/**
 * The cap on rendered `error_description` text: it arrives from a URL param
 * with no reason to be short, and the login card is not a scrollback.
 */
const REFUSAL_TEXT_MAX = 200;

/** Whitespace-collapsed, trimmed, capped — the sanitizer the `refused` half uses. */
function refusalText(description: string | undefined): string {
  return (description ?? "").replace(/\s+/g, " ").trim().slice(0, REFUSAL_TEXT_MAX);
}

/**
 * The label of one provider's sign-in button (operator contract, 2026-09-24).
 *
 * **The name, never the kind.** Several providers of one kind are legal —
 * `kind` is only the config preset, the admin's chosen NAME is the identity,
 * and the immutable id is a slug derived from that name. Two rows can both
 * be `google` ("Google (Acme)" and "Google (Personal)"), and a kind-first
 * label would render them indistinguishable: a mis-click then sends the
 * visitor to the wrong IdP's consent screen. The name IS the disambiguator,
 * so it is what the button wears, for every kind.
 */
export function signInButtonLabel(provider: { name: string }): string {
  return `Sign in with ${provider.name}`;
}

/**
 * Map the login page's search params onto {@link AuthErrorDecision}.
 *
 * Pure by construction: it reads only the params passed in, so every shape is
 * testable without a router, a DOM, or a clock. `error_description` is the
 * provider policy's email ONLY for `pending_approval` — other codes carry free
 * text, which is rendered as prose (sanitized, capped) and never treated as
 * an address. A description with NO `error` code is a stray param, not a
 * round trip: nothing renders (`none`), because there is no refusal to name.
 */
export function mapAuthError(params: { error?: string; error_description?: string }): AuthErrorDecision {
  if (params.error === "pending_approval") {
    return { kind: "pending", email: params.error_description || null };
  }
  if (params.error === "unable_to_create_session") {
    return { kind: "generic", message: SIGN_IN_UNABLE };
  }
  if (params.error === undefined) return { kind: "none" };
  const text = refusalText(params.error_description);
  return { kind: "refused", message: text === "" ? ROUND_TRIP_REFUSED : text };
}
