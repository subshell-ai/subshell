import { describe, expect, it } from "bun:test";
import { SESSION_CHECK_FAILED, signInDiagnosis } from "@/lib/sign-in-diagnosis";

/**
 * A sign-in the server ACCEPTED that left no session (operator's report,
 * 2026-09-18). better-auth derives cookie security from `APP_BASE_URL`, so an
 * https base URL marks the session cookie `Secure` and prefixes it
 * `__Secure-` — which a browser on an http page discards on receipt. The
 * redirect to `/` then bounces back to the form, which reads as a rejected
 * password.
 */
describe("signInDiagnosis", () => {
  it("names this page's own protocol when inside Subshell Server on http", () => {
    const d = signInDiagnosis({ inServerApp: true, protocol: "http:" });
    // The fact a person cannot see: the cookie was refused because of the
    // protocol this page is on, not because of what they typed.
    expect(d.message).toMatch(/This page is on http/);
    expect(d.message).toMatch(/Secure/);
    // **The remedy has to be reachable from here** (review, 2026-09-18). It
    // named Server Settings → Networking, which is precisely what this branch
    // says cannot be opened: no session can be stored. The assistant's Server
    // Addresses screen drives the CLI and needs none.
    expect(d.remedy).toMatch(/tray menu/);
    expect(d.remedy).not.toMatch(/Server Settings/);
  });

  /**
   * A check that could not RUN is its own answer (review, 2026-09-18).
   *
   * `getSessionUser` throws on anything that is not a 401/403, precisely so a
   * failed read is never read as signed-out — so the login page must not fold
   * that into the cookie diagnosis, whose remedy would send someone to change
   * an address that works.
   */
  it("keeps 'could not check' apart from every diagnosis it could be mistaken for", () => {
    expect(SESSION_CHECK_FAILED).toMatch(/^Signed in, but/);
    expect(SESSION_CHECK_FAILED).not.toMatch(/password|incorrect|invalid/i);
    // It names no remedy about addresses, because it is not about one.
    expect(SESSION_CHECK_FAILED).not.toMatch(/https|Secure|tray|base URL/);
    for (const inServerApp of [true, false]) {
      for (const protocol of ["http:", "https:"]) {
        expect(signInDiagnosis({ inServerApp, protocol }).message).not.toBe(SESSION_CHECK_FAILED);
      }
    }
  });

  // Never "wrong password": the server accepted it, and saying otherwise sends
  // someone to reset a credential that works.
  it("never blames the credentials", () => {
    for (const inServerApp of [true, false]) {
      for (const protocol of ["http:", "https:"]) {
        const d = signInDiagnosis({ inServerApp, protocol });
        expect(`${d.message} ${d.remedy}`).not.toMatch(/password|incorrect|invalid/i);
        expect(d.message).toMatch(/^Signed in, but/);
      }
    }
  });

  it("explains the plain-http browser case without naming the app", () => {
    const d = signInDiagnosis({ inServerApp: false, protocol: "http:" });
    expect(d.message).toMatch(/Secure/);
    expect(d.message).not.toMatch(/Subshell Server's window/);
    expect(d.remedy).toMatch(/https address/);
  });

  /**
   * On https the cookie was refused for a reason this page cannot see. A
   * remedy here would be a guess, and a wrong remedy on a sign-in screen is
   * worse than none.
   */
  it("offers no remedy it cannot stand behind", () => {
    const d = signInDiagnosis({ inServerApp: false, protocol: "https:" });
    expect(d.remedy).toBe("");
    expect(d.message).toMatch(/no session was stored/);
  });
});
