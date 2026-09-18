import { describe, expect, it } from "bun:test";
import { signInDiagnosis } from "@/lib/sign-in-diagnosis";

/**
 * A sign-in the server ACCEPTED that left no session (operator's report,
 * 2026-09-18). better-auth derives cookie security from `APP_BASE_URL`, so an
 * https base URL marks the session cookie `Secure` and prefixes it
 * `__Secure-` — which a browser on an http page discards on receipt. The
 * redirect to `/` then bounces back to the form, which reads as a rejected
 * password.
 */
describe("signInDiagnosis", () => {
  it("names the window's own pin when inside Subshell Server on http", () => {
    const d = signInDiagnosis({ inServerApp: true, protocol: "http:" });
    // The fact a person cannot see: this window is ALWAYS http, so the
    // mismatch is the app's shape rather than something they chose.
    expect(d.message).toMatch(/always loads this machine over http/);
    expect(d.message).toMatch(/Secure/);
    expect(d.remedy).toMatch(/Server Settings → Networking/);
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
