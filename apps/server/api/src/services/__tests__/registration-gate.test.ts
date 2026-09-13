import { describe, expect, it } from "bun:test";
import { registrationDecision } from "@/services/registration-gate.js";

/**
 * The registration rule, including the one case that makes a closed default
 * possible at all.
 *
 * Driven through the PURE decision rather than the database: the suite shares
 * one DB across files, so asserting "no users exist" against the real count
 * passes alone and fails beside any test that registers someone — which is
 * exactly how this test first failed.
 */
describe("registrationDecision", () => {
  it("is OPEN with no row and no users — the first admin has to be creatable", () => {
    // Closed here would brick a fresh install: the FIRST account registered
    // becomes the admin, so a closed empty instance could never mint the one
    // person able to open it, and the boot wizard would point at a sign-up
    // form that refuses.
    expect(registrationDecision(undefined, false)).toBe(true);
  });

  it("is CLOSED with no row once a user exists — the door shuts behind itself", () => {
    // The change: an instance no longer ships accepting sign-ups from anyone
    // who can reach it until an admin happens to notice.
    expect(registrationDecision(undefined, true)).toBe(false);
  });

  it("honours an explicit answer either way, users or not", () => {
    expect(registrationDecision("true", true)).toBe(true);
    expect(registrationDecision("true", false)).toBe(true);
    expect(registrationDecision("false", false)).toBe(false);
    // Explicit false wins even in the first-run window: an operator who said
    // no before anyone registered meant it.
    expect(registrationDecision("false", true)).toBe(false);
  });

  it("FAILS CLOSED on a corrupt or non-boolean row, even with no users", () => {
    // Treating corruption as open turns a damaged settings row into silently
    // re-opened registration (security audit 2026-08, F6a) — and the no-users
    // carve-out must not become a way back in for it.
    for (const bad of ["not json", '"true"', "1", "null", "{}", ""]) {
      expect(registrationDecision(bad, false)).toBe(false);
      expect(registrationDecision(bad, true)).toBe(false);
    }
  });
});
