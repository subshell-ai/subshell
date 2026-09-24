import type { ValidateUserInfoSource } from "better-auth";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { asApprovalState } from "@/db/types/approval-state.js";
import type { AuthProviderRow } from "@/db/types/auth-providers.db-types.js";
import type { Database } from "@/db/types/index.js";
import { registrationOpen } from "@/services/registration-gate.js";

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
 * `{ user, source: { action, method, oauth?: { providerId, profile? } } }`
 * — the measured shape, spelled out on {@link DoorValidationData} below;
 * the caller unpacks it into {@link DoorPolicyInput} before this runs.
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

/**
 * The MEASURED 1.7.1 `validateUserInfo` input: `{ user, source }`, the action
 * spelled INSIDE `source` (`dist/db/internal-adapter.mjs`,
 * `dist/oauth2/link-account.mjs`, `dist/api/routes/callback.mjs` — the four
 * call sites, all read; there is no top-level `action`/`profile` member).
 * Typed as the upstream `ValidateUserInfoSource` so a better-auth upgrade
 * that renames a member fails typecheck here rather than silently reading
 * `undefined` and answering `door_closed` for everyone.
 */
export interface DoorValidationData {
  user?: Record<string, unknown> | undefined;
  source?: ValidateUserInfoSource | undefined;
}

/** The three action spellings 1.7.1 fires; anything else reads as "sign-in". */
const DOOR_ACTIONS: readonly string[] = ["create-user", "link-account", "sign-in"];

/**
 * The DB-backed half: resolve the door, the email's existing state, and (only
 * when the pure layer needs it) the E-mail gate, then answer. This is what
 * `AUTH_OPTIONS.user.validateUserInfo` runs; it also does the §6 `arrived_at`
 * touch on a pending refusal — validation hooks are allowed one write here
 * and this is the ONLY one, because the knock timestamp is queue bookkeeping,
 * not policy. Fails CLOSED on its own throws: `assertValidUserInfo` turns a
 * throw into `validation_failed` 403 (measured), which is the right direction
 * for a broken reader.
 *
 * Two readings worth naming because they are decisions, not accidents:
 *
 * - A row that exists but says `enabled = 0` is NOT a door. `buildAuth` never
 *   builds a disabled door (so no callback route exists to fire this hook for
 *   one), but `evaluate` answers from the table, and the honest reading of a
 *   disabled row is `door_closed` whatever wrote it.
 * - `registrationEnabled = NULL` is the legacy dynamic window ONLY for the
 *   email row. On an oidc row it is a hand edit (the route always writes an
 *   explicit 0/1), and the pure cascade's `=== false` would read NULL as
 *   open — so `resolveDoor` coerces it CLOSED on non-email rows.
 */
export async function evaluateDoorPolicy(
  db: Kysely<Database>,
  data: DoorValidationData,
): Promise<DoorRefusal | undefined> {
  const user = (data.user ?? {}) as Record<string, unknown>;
  const email = String(user.email ?? "")
    .trim()
    .toLowerCase();
  const method = data.source?.method;
  const isOauth = method === "oauth";
  const oauthProfile = (data.source?.oauth?.profile ?? {}) as Record<string, unknown>;
  // The verified claim, whichever layer carries it: the mapped user record
  // (mapProfileToUser spells it `emailVerified`) or the raw provider profile
  // (`email_verified`, the OIDC claim, still unmapped on the link seams).
  const emailVerified =
    user.emailVerified === true || oauthProfile.email_verified === true || oauthProfile.emailVerified === true;
  const rawAction = data.source?.action;
  const action: DoorAction = (DOOR_ACTIONS.includes(String(rawAction)) ? rawAction : "sign-in") as DoorAction;

  if (isOauth) {
    const providerId = data.source?.oauth?.providerId ?? "";
    const row = await new AuthProvidersRepository(db).getById(providerId);
    // The email row is not an OAuth door (kind check = defence against a
    // provider hand-configured under the id "email"); undefined = unconfigured.
    const door = row === undefined || row.kind === "email" || row.enabled !== 1 ? null : resolveDoor(row);
    const existingState = email === "" ? null : await stateByEmail(db, email);
    const decision = decideDoorPolicy({
      action,
      method: "oauth",
      providerId,
      email,
      emailVerified,
      door,
      existingState,
    });
    // §6 dedup: a repeat knock on a still-pending arrival refreshes the
    // expiry clock. A REJECTED row answers the same code but is not waiting
    // on anyone, and must not re-enter the queue's view.
    if (decision?.error === "pending_approval" && existingState === "pending") {
      await new UserMetaRepository(db).touchPendingArrivedByEmail(email);
    }
    return decision;
  }

  // Email-password sign-up (the measured email-password seam) — and any other
  // non-oauth method — through the EMAIL door. better-auth spells further
  // methods ("anonymous", "phone-number", …) we have not enabled; enabling
  // one later is a door-policy decision, and reading it as the email door
  // fails toward the door admins can actually see and close.
  const emailRow = await new AuthProvidersRepository(db).getById("email");
  // `enabled !== 1` is no-door, the SAME reading the oauth branch gives a
  // disabled row: unreachable today (migration 0037 seeds 1 and nothing
  // writes 0), but a hand-edited disabled row must read door_closed rather
  // than opening a door the table says is shut.
  const door = emailRow === undefined || emailRow.enabled !== 1 ? null : resolveDoor(emailRow);
  const existingState = email === "" ? null : await stateByEmail(db, email);
  return decideDoorPolicy({
    action,
    method: "email-password",
    email,
    emailVerified,
    door,
    existingState,
    emailRegistrationOpen: await registrationOpen(db),
  });
}

function resolveDoor(row: AuthProviderRow): DoorPolicyInput["door"] {
  return {
    signInEnabled: row.signInEnabled === 1,
    registrationEnabled:
      row.kind === "email"
        ? row.registrationEnabled === null
          ? null
          : row.registrationEnabled === 1
        : row.registrationEnabled === 1, // NULL on a non-email row reads CLOSED (fail-closed)
    requireApproval: row.requireApproval === 1,
    allowedDomains:
      row.allowedDomains === null || row.allowedDomains === ""
        ? []
        : row.allowedDomains
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean),
  };
}

/**
 * The approval state of the user ALREADY holding this email — `null` only
 * when nobody does. A user row with no `user_meta` row reads APPROVED (the
 * `asApprovalState` rule), which matters: such a person exists and must not
 * sail past the pending gate as if they were a new arrival.
 *
 * Raw SQL because it spans better-auth's `user` (outside the typed Database,
 * plugin-bypassing camelCase columns) and the app's `user_meta` in one
 * statement. No LIMIT: `email` is UNIQUE, and two rows would be a corruption
 * this read must not silently rank.
 */
async function stateByEmail(db: Kysely<Database>, email: string): Promise<DoorPolicyInput["existingState"]> {
  if (email === "") return null;
  const r = await sql<{ state: string | null }>`
    SELECT m.approval_state AS state FROM user u
    LEFT JOIN user_meta m ON m.user_id = u.id
    WHERE lower(u.email) = ${email}
  `.execute(db);
  if (r.rows.length === 0) return null;
  return asApprovalState(r.rows[0].state);
}
