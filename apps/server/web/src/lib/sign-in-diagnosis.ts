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
