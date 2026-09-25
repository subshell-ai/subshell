import type { Kysely } from "kysely";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { Database } from "@/db/types/index.js";

/**
 * Whether this account is disabled, and therefore may not authenticate.
 *
 * **One function, because two surfaces have to agree**: better-auth's
 * `session.create.before` hook refuses to mint a session for a disabled user
 * (which covers password AND passkey sign-in, since both mint one), and
 * `authGuard` rejects a disabled user on the cookie and bearer paths alike.
 * Without the second, a disabled user's still-running subshell tokens would
 * keep working and "disabled" would not be true of the account; without the
 * first, a disabled user could still mint fresh cookies. The same shape as
 * `services/registration-gate.ts`, and for the same reason: a second reading
 * of the row is how the two surfaces come to disagree.
 *
 * An ABSENT `user_meta` row reads as ENABLED, matching the column's own
 * default. That direction is load-bearing — inverting it would lock out every
 * account minted before the column existed, on the upgrade that added it.
 *
 * This module holds NO import-time IO (it takes the database as an argument
 * and the repository it uses imports only types), which is what lets
 * `auth.ts` import it without breaking the entry graph's import purity.
 *
 * @param db - the app database
 * @param userId - better-auth user id
 */
export async function accountDisabled(db: Kysely<Database>, userId: string): Promise<boolean> {
  return await new UserMetaRepository(db).isDisabled(userId);
}

/**
 * Whether this account is PENDING APPROVAL — arrived through a
 * require-approval provider and not yet admitted (spec 2026-09-24 §4).
 *
 * The same one-function discipline as {@link accountDisabled}, for the same
 * reason: better-auth's `session.create.before` hook refuses to mint a
 * session for such an account, and the provider policy
 * (`auth/provider-policy.ts` → `validateUserInfo`) refuses the provisioning
 * request that would have led to it. Two readings of `approval_state` are
 * how those surfaces come to disagree about who may sign in; this is the
 * one reader of the session side, and it goes through
 * `UserMetaRepository.approvalState` like the disabled check goes through
 * `isDisabled`. An absent row reads APPROVED (the upgrade rule the
 * repository documents); only the exact pending state refuses.
 *
 * @param db - the app database
 * @param userId - better-auth user id
 */
export async function accountPending(db: Kysely<Database>, userId: string): Promise<boolean> {
  return (await new UserMetaRepository(db).approvalState(userId)) === "pending";
}
