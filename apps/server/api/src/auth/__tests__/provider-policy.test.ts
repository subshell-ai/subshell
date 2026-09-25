import { describe, expect, test } from "bun:test";
import { decideProviderPolicy, domainAllowed, type ProviderPolicyInput } from "@/auth/provider-policy.js";

/** One open, unrestricted provider, spelled once (review fold a: the old `provider!`
 * non-null assertions said nothing the constant could not say). */
const openProvider: NonNullable<ProviderPolicyInput["provider"]> = {
  signInEnabled: true,
  registrationEnabled: true,
  requireApproval: false,
  allowedDomains: [],
};

const base = (over: Partial<ProviderPolicyInput>): ProviderPolicyInput => ({
  action: "sign-in",
  method: "oauth",
  providerId: "acme",
  email: "a@acme.com",
  emailVerified: true,
  provider: openProvider,
  existingState: null,
  ...over,
});

describe("decideProviderPolicy", () => {
  test("approved paths sail through", () => {
    expect(decideProviderPolicy(base({}))).toBeUndefined();
    expect(decideProviderPolicy(base({ action: "create-user", existingState: null }))).toBeUndefined();
    expect(decideProviderPolicy(base({ action: "link-account", existingState: "approved" }))).toBeUndefined();
  });
  test("unknown or disabled provider refuses everything with provider_closed", () => {
    for (const a of ["sign-in", "link-account", "create-user"] as const)
      expect(decideProviderPolicy(base({ action: a, provider: null }))).toEqual({ error: "provider_closed" });
    expect(decideProviderPolicy(base({ provider: { ...openProvider, signInEnabled: false } }))).toEqual({
      error: "provider_closed",
    });
  });
  test("create-user with registration off refuses; sign-in and link still pass", () => {
    const off = { ...openProvider, registrationEnabled: false };
    expect(decideProviderPolicy(base({ action: "create-user", provider: off }))).toEqual({
      error: "registration_closed",
    });
    expect(decideProviderPolicy(base({ action: "sign-in", provider: off, existingState: "approved" }))).toBeUndefined();
  });
  test("requireApproval creates are ALLOWED (pending is marked post-creation, §4)", () => {
    expect(
      decideProviderPolicy(base({ action: "create-user", provider: { ...openProvider, requireApproval: true } })),
    ).toBeUndefined();
  });
  test("pending and rejected refuse sign-in AND link-account with the named code + echoed email", () => {
    for (const state of ["pending", "rejected"] as const) {
      for (const a of ["sign-in", "link-account"] as const)
        expect(
          decideProviderPolicy(
            base({ action: a, existingState: state, provider: { ...openProvider, requireApproval: true } }),
          ),
        ).toEqual({ error: "pending_approval", errorDescription: "a@acme.com" });
    }
    // create-user against an existing pending user never happens (email taken) —
    // but assert the guard anyway: existing non-approved state refuses create too.
    expect(decideProviderPolicy(base({ action: "create-user", existingState: "pending" }))).toEqual({
      error: "pending_approval",
      errorDescription: "a@acme.com",
    });
  });
  test("a pending row outranks a closed registration provider (cascade order, fold c)", () => {
    // The order-discriminator: the non-approved-existing check runs BEFORE
    // the per-action registration check, so the person in the queue hears
    // WHY they cannot in (`pending_approval`, which the login page maps to
    // /pending) and not the provider's posture. A future reorder that answers
    // registration_closed here flips this test.
    expect(
      decideProviderPolicy(
        base({
          action: "create-user",
          existingState: "pending",
          provider: { ...openProvider, registrationEnabled: false },
        }),
      ),
    ).toEqual({ error: "pending_approval", errorDescription: "a@acme.com" });
  });
  test("unverified email refuses link-account ONLY (§5: create may proceed, verification is the link defense)", () => {
    expect(decideProviderPolicy(base({ action: "link-account", emailVerified: false }))).toEqual({
      error: "unverified_email",
    });
    expect(decideProviderPolicy(base({ action: "create-user", emailVerified: false }))).toBeUndefined();
  });
  test("domain gate refuses all three actions when the email is outside (§5)", () => {
    const gated = { ...openProvider, allowedDomains: ["acme.com"] };
    expect(decideProviderPolicy(base({ email: "intruder@evil.com", action: "sign-in", provider: gated }))).toEqual({
      error: "domain_not_allowed",
    });
    expect(decideProviderPolicy(base({ email: "x@acme.com", action: "sign-in", provider: gated }))).toBeUndefined();
    expect(decideProviderPolicy(base({ action: "create-user", email: "x@evil.com", provider: gated }))).toEqual({
      error: "domain_not_allowed",
    });
  });
  test("email-password: create-user consults emailRegistrationOpen; sign-in consults signInEnabled", () => {
    const emailProvider = {
      signInEnabled: true,
      registrationEnabled: null,
      requireApproval: false,
      allowedDomains: [],
    };
    expect(
      decideProviderPolicy(
        base({
          method: "email-password",
          providerId: undefined,
          action: "create-user",
          provider: emailProvider,
          emailRegistrationOpen: true,
        }),
      ),
    ).toBeUndefined();
    expect(
      decideProviderPolicy(
        base({
          method: "email-password",
          action: "create-user",
          provider: emailProvider,
          emailRegistrationOpen: false,
        }),
      ),
    ).toEqual({ error: "registration_closed" });
    // Fold b: OMITTED is not open. The caller is contracted to resolve the
    // null-dynamic via `registrationOpen()` and pass the answer; a caller
    // that forgets must fail closed, not gain the legacy window's benefit
    // of the doubt (`!== true`, not `=== false`).
    expect(
      decideProviderPolicy(base({ method: "email-password", action: "create-user", provider: emailProvider })),
    ).toEqual({
      error: "registration_closed",
    });
    expect(
      decideProviderPolicy(
        base({ method: "email-password", action: "sign-in", provider: { ...emailProvider, signInEnabled: false } }),
      ),
    ).toEqual({ error: "provider_closed" });
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
