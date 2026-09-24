/** Actions better-auth's `user.validateUserInfo` hook can fire for. */
export type DoorAction = "create-user" | "link-account" | "sign-in";
/** How the caller authenticated: an OAuth/OIDC door or the email/password door. */
export type DoorMethod = "oauth" | "email-password";

export interface DoorPolicyInput {
  action: DoorAction;
  method: DoorMethod;
  /** oauth only: the providerId from source.oauth.providerId. */
  providerId?: string;
  email: string;
  emailVerified: boolean;
  /** The resolved door row; `null` = providerId not configured/enabled. */
  door: {
    signInEnabled: boolean;
    registrationEnabled: boolean | null;
    requireApproval: boolean;
    allowedDomains: string[];
  } | null;
  /** For the `email` door only: the caller resolves the null-dynamic via
   * `registrationOpen()` and passes the ANSWER here — the pure function never
   * counts users. */
  emailRegistrationOpen?: boolean;
  /** approval_state of the user already holding this email; null = nobody. */
  existingState: "approved" | "pending" | "rejected" | null;
}

export interface DoorRefusal {
  error: string;
  errorDescription?: string;
}

/**
 * The door policy, pure (spec 2026-09-24 §3–§5). Everything the provider
 * table decides is decided HERE, in one ordered cascade, because 1.7.1 has
 * ONE global `user.validateUserInfo` hook (no per-provider hook exists —
 * measured) and every policy question arrives as
 * `{ source: { method, oauth?: { providerId } }, action, profile }`.
 *
 * Order matters and is the spec's own: door (exists + open) → domain →
 * non-approved existing → unverified link → per-action registration.
 * Refusal strings are stable wire codes: `pending_approval` in particular is
 * what the login page maps onto `/pending` (§4), so a rename is a UI bug.
 */
export function decideDoorPolicy(i: DoorPolicyInput): DoorRefusal | undefined {
  if (i.door === null || !i.door.signInEnabled) return { error: "door_closed" };
  if (!domainAllowed(i.door.allowedDomains, i.email)) return { error: "domain_not_allowed" };
  if (i.existingState === "pending" || i.existingState === "rejected")
    return { error: "pending_approval", errorDescription: i.email };
  if (i.action === "link-account" && !i.emailVerified) return { error: "unverified_email" };
  if (i.action === "create-user") {
    if (i.method === "email-password") {
      if (i.emailRegistrationOpen !== true) return { error: "registration_closed" };
    } else if (i.door.registrationEnabled === false) {
      return { error: "registration_closed" };
    }
    // requireApproval needs NO branch: the row is created (the queue IS the
    // row) and the session refusal (§4) + account.create.after marking own it.
  }
  return undefined;
}

export function domainAllowed(allowedDomains: readonly string[], email: string): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return allowedDomains.some((d) => {
    const entry = d.toLowerCase();
    return domain === entry || domain.endsWith(`.${entry}`);
  });
}
