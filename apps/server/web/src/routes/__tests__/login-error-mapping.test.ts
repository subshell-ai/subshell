import { describe, expect, it } from "bun:test";
import { mapAuthError, ROUND_TRIP_REFUSED, SIGN_IN_UNABLE, signInButtonLabel } from "@/lib/sign-in-diagnosis";
import type { InstanceSignInProvider } from "@/types/auth-provider";

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

  /**
   * The shape this case used to pin — "passes anything else through to the
   * existing error UI" — described a pass-through the PAGE NEVER HAD (final
   * review, Important 2): `login.tsx`'s error STATE is fed by the form's own
   * failures only, so every unrecognized code was stripped from the URL and
   * painted nothing. A `?error=` now maps to `refused` and renders; a stray
   * `error_description` with no code stays unrendered (there is no refusal to
   * name), and a bare mount stays `none` — the fresh page is not a report.
   */
  it("refuses to go silent: any carried code renders a sanitized sentence", () => {
    expect(mapAuthError({})).toEqual({ kind: "none" });
    // A provider's own refusal renders the provider's own words as PROSE —
    // never as an address; that reading belongs to `pending_approval` alone.
    expect(mapAuthError({ error: "door_closed", error_description: "That door is closed." })).toEqual({
      kind: "refused",
      message: "That door is closed.",
    });
    // The door policy's other named refusals, description-less: the fallback.
    for (const code of ["registration_closed", "domain_not_allowed", "door_closed"]) {
      expect(mapAuthError({ error: code })).toEqual({ kind: "refused", message: ROUND_TRIP_REFUSED });
    }
    // A URL param is no reason for a long render: whitespace collapses and
    // the text is capped, so the login card stays a card.
    const messy = mapAuthError({
      error: "provider_said",
      error_description: `  user   denied\nthe request  ${"x".repeat(500)}  `,
    });
    expect(messy.kind).toBe("refused");
    if (messy.kind !== "refused") return;
    expect(messy.message).toStartWith("user denied the request");
    expect(messy.message.length).toBeLessThanOrEqual(200);
    // The description alone names no refusal: it is a stray param, and the
    // page must not read an un-carried code's leftover as a message.
    expect(mapAuthError({ error_description: "ada@example.com" })).toEqual({ kind: "none" });
  });
});

/**
 * The sign-in button's label (operator contract, 2026-09-24, overriding the
 * brief's kind-special-case copy): the NAME is worn for every kind, because
 * same-kind doors are legal and a mis-click between two indistinguishable
 * "Sign in with Google" buttons lands the visitor on the WRONG IdP's consent
 * screen. `routes/login.tsx` renders exactly this helper per provider.
 */
describe("signInButtonLabel", () => {
  it("renders two google-kind providers as two distinct labels, from their names", () => {
    const acme: InstanceSignInProvider = { id: "google-acme", kind: "google", name: "Google (Acme)" };
    const personal: InstanceSignInProvider = { id: "google-personal", kind: "google", name: "Google (Personal)" };
    const acmeLabel = signInButtonLabel(acme);
    const personalLabel = signInButtonLabel(personal);
    expect(acmeLabel).toBe("Sign in with Google (Acme)");
    expect(personalLabel).toBe("Sign in with Google (Personal)");
    // The contract's whole point: distinct, and each named by its row.
    expect(acmeLabel).not.toBe(personalLabel);
    expect(acmeLabel).toContain("Google (Acme)");
    expect(personalLabel).toContain("Google (Personal)");
  });

  it("labels every kind the same way — no kind special-casing", () => {
    // The old brief copy would return "Sign in with Google" here, discarding
    // the admin's chosen name; that reading is superseded.
    const renamedGoogle: InstanceSignInProvider = { id: "google", kind: "google", name: "Workspace" };
    const corp: InstanceSignInProvider = { id: "hr", kind: "oidc", name: "Corp SSO" };
    expect(signInButtonLabel(renamedGoogle)).toBe("Sign in with Workspace");
    expect(signInButtonLabel(corp)).toBe("Sign in with Corp SSO");
  });
});
