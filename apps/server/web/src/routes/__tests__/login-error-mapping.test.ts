import { describe, expect, it } from "bun:test";
import { mapAuthError, SIGN_IN_UNABLE } from "@/lib/sign-in-diagnosis";

/**
 * The login page's reading of a failed OAuth round trip (spec 2026-09-24 §4).
 * better-auth returns to `/login` with `?error=<code>&error_description=<text>`
 * appended by the server; the door policy's refusal codes are STABLE WIRE
 * STRINGS (`decideDoorPolicy` names them, and `pending_approval` in
 * particular is the code whose whole job is to select `/pending`), so this
 * mapper is the seam between that vocabulary and the screen. Pure, and tested
 * as such: no router, no DOM, no clock.
 */
describe("mapAuthError", () => {
  it("selects the waiting room for a pending refusal, carrying the email", () => {
    expect(mapAuthError({ error: "pending_approval", error_description: "ada@example.com" })).toEqual({
      kind: "pending",
      email: "ada@example.com",
    });
  });

  it("still selects the waiting room when the refusal named no email", () => {
    // The field is optional on the wire; absence is a shape, not an error.
    expect(mapAuthError({ error: "pending_approval" })).toEqual({ kind: "pending", email: null });
    // And an empty string is absence too — never an empty chip on /pending.
    expect(mapAuthError({ error: "pending_approval", error_description: "" })).toEqual({
      kind: "pending",
      email: null,
    });
  });

  it("answers a sessionless round trip with the honest generic sentence", () => {
    expect(mapAuthError({ error: "unable_to_create_session" })).toEqual({
      kind: "generic",
      message: SIGN_IN_UNABLE,
    });
    // The spec §4 line, spelled exactly: no em dash, two sentences (a rename
    // here is a copy change, and the copy was chosen, not typed at random).
    expect(SIGN_IN_UNABLE).toBe(
      "Sign-in could not complete. Access may be pending approval or disabled, so contact an admin.",
    );
    expect(SIGN_IN_UNABLE).not.toContain("—");
  });

  it("passes anything else through to the existing error UI", () => {
    expect(mapAuthError({})).toEqual({ kind: "none" });
    // A provider's own refusal stays the provider's own refusal: its
    // error_description is free text and must not be read as an address.
    expect(mapAuthError({ error: "door_closed", error_description: "That door is closed." })).toEqual({
      kind: "none",
    });
    expect(mapAuthError({ error_description: "ada@example.com" })).toEqual({ kind: "none" });
  });
});
