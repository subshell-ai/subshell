import { describe, expect, test } from "bun:test";
import { type DoorPolicyInput, decideDoorPolicy, domainAllowed } from "@/auth/door-policy.js";

const base = (over: Partial<DoorPolicyInput>): DoorPolicyInput => ({
  action: "sign-in",
  method: "oauth",
  providerId: "acme",
  email: "a@acme.com",
  emailVerified: true,
  door: { signInEnabled: true, registrationEnabled: true, requireApproval: false, allowedDomains: [] },
  existingState: null,
  ...over,
});

describe("decideDoorPolicy", () => {
  test("approved paths sail through", () => {
    expect(decideDoorPolicy(base({}))).toBeUndefined();
    expect(decideDoorPolicy(base({ action: "create-user", existingState: null }))).toBeUndefined();
    expect(decideDoorPolicy(base({ action: "link-account", existingState: "approved" }))).toBeUndefined();
  });
  test("unknown or disabled door refuses everything with door_closed", () => {
    for (const a of ["sign-in", "link-account", "create-user"] as const)
      expect(decideDoorPolicy(base({ action: a, door: null }))).toEqual({ error: "door_closed" });
    expect(decideDoorPolicy(base({ door: { ...base({}).door!, signInEnabled: false } }))).toEqual({
      error: "door_closed",
    });
  });
  test("create-user with registration off refuses; sign-in and link still pass", () => {
    const off = { ...base({}).door!, registrationEnabled: false };
    expect(decideDoorPolicy(base({ action: "create-user", door: off }))).toEqual({ error: "registration_closed" });
    expect(decideDoorPolicy(base({ action: "sign-in", door: off, existingState: "approved" }))).toBeUndefined();
  });
  test("requireApproval creates are ALLOWED (pending is marked post-creation, §4)", () => {
    expect(
      decideDoorPolicy(base({ action: "create-user", door: { ...base({}).door!, requireApproval: true } })),
    ).toBeUndefined();
  });
  test("pending and rejected refuse sign-in AND link-account with the named code + echoed email", () => {
    for (const state of ["pending", "rejected"] as const) {
      for (const a of ["sign-in", "link-account"] as const)
        expect(
          decideDoorPolicy(
            base({ action: a, existingState: state, door: { ...base({}).door!, requireApproval: true } }),
          ),
        ).toEqual({ error: "pending_approval", errorDescription: "a@acme.com" });
    }
    // create-user against an existing pending user never happens (email taken) —
    // but assert the guard anyway: existing non-approved state refuses create too.
    expect(decideDoorPolicy(base({ action: "create-user", existingState: "pending" }))).toEqual({
      error: "pending_approval",
      errorDescription: "a@acme.com",
    });
  });
  test("unverified email refuses link-account ONLY (§5: create may proceed, verification is the link defense)", () => {
    expect(decideDoorPolicy(base({ action: "link-account", emailVerified: false }))).toEqual({
      error: "unverified_email",
    });
    expect(decideDoorPolicy(base({ action: "create-user", emailVerified: false }))).toBeUndefined();
  });
  test("domain gate refuses all three actions when the email is outside (§5)", () => {
    const gated = { ...base({}).door!, allowedDomains: ["acme.com"] };
    expect(decideDoorPolicy(base({ email: "intruder@evil.com", action: "sign-in", door: gated }))).toEqual({
      error: "domain_not_allowed",
    });
    expect(decideDoorPolicy(base({ email: "x@acme.com", action: "sign-in", door: gated }))).toBeUndefined();
    expect(decideDoorPolicy(base({ action: "create-user", email: "x@evil.com", door: gated }))).toEqual({
      error: "domain_not_allowed",
    });
  });
  test("email-password: create-user consults emailRegistrationOpen; sign-in consults signInEnabled", () => {
    const emailDoor = { signInEnabled: true, registrationEnabled: null, requireApproval: false, allowedDomains: [] };
    expect(
      decideDoorPolicy(
        base({
          method: "email-password",
          providerId: undefined,
          action: "create-user",
          door: emailDoor,
          emailRegistrationOpen: true,
        }),
      ),
    ).toBeUndefined();
    expect(
      decideDoorPolicy(
        base({ method: "email-password", action: "create-user", door: emailDoor, emailRegistrationOpen: false }),
      ),
    ).toEqual({ error: "registration_closed" });
    expect(
      decideDoorPolicy(
        base({ method: "email-password", action: "sign-in", door: { ...emailDoor, signInEnabled: false } }),
      ),
    ).toEqual({ error: "door_closed" });
  });
});

describe("domainAllowed", () => {
  test("suffix rule: exact or dot-suffix, case-folded, no lookalikes (§5)", () => {
    expect(domainAllowed(["ACME.com"], "a@acme.com")).toBe(true);
    expect(domainAllowed(["acme.com"], "a@mail.acme.com")).toBe(true);
    expect(domainAllowed(["acme.com"], "a@evilacme.com")).toBe(false);
    expect(domainAllowed(["acme.com"], "a@acme.com.evil.net")).toBe(false);
    expect(domainAllowed([], "a@anything")).toBe(true); // empty list = any
  });
});
