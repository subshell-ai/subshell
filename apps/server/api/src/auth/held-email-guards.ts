import { APIError } from "better-auth/api";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "@/db/types/index.js";
import { registrationOpen } from "@/services/registration-gate.js";

/**
 * The provider-NAMED refusal of email sign-ups for an address an OIDC account
 * already holds (spec 2026-09-24 §5's honest message, operator ruling 2026-09-24).
 *
 * WHY a `hooks.before` on `/sign-up/email` and not `user.create.before`, stated
 * because the seam was MEASURED, not assumed (better-auth 1.7.1,
 * `dist/api/routes/sign-up.mjs`): the route's handler runs
 * `internalAdapter.findUserByEmail` and throws
 * `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (422) BEFORE it reaches
 * `internalAdapter.createUser` — and `createUser` is where `with-hooks.mjs`
 * fires `databaseHooks.user.create.before` AND where `assertValidUserInfo`
 * (`dist/utils/validate-user-info.mjs`) runs the door policy. So for a HELD
 * email neither the create hook nor `validateUserInfo` ever runs: the
 * registration gate's `registration_closed` answers only free addresses, and
 * a held one gets better-auth's generic sentence whatever the door table
 * says. `hooks.before` is the only layer that runs earlier — dispatch
 * (`dist/api/dispatch.mjs` `dispatchAuthEndpoint`) runs the user's before
 * hooks over the whole input context (`path` and the PARSED `body` are both
 * on it — better-auth's own username plugin matches `/sign-up/email` there
 * and reads `ctx.body`) and reaches the endpoint handler only afterwards.
 *
 * The refusal is a THROWN `APIError(403)`, the shape `door-guards.ts`
 * established for this seam, so the better-auth client surfaces `message` as
 * `error.message` and the login/wizard forms render the sentence plainly
 * (their refusal path is `setError(err.message ?? ...)`).
 *
 * ORDER — the registration gate first, then the named holder, then
 * better-auth's own path. Under a closed gate the answer is the instance's
 * existing `registration_closed` refusal, byte-identical on the wire to what
 * `validateUserInfo` writes for a free address (`{code, message}` both
 * "registration_closed", 403) — so a closed door gives EVERY sign-up attempt
 * the same reply, held address or not, and cannot be probed for which address
 * an OIDC account owns. That uniformity replaces one old leak rather than
 * adding one: until this guard sat on the path, a closed gate answered
 * `registration_closed` for a free address and better-auth's generic
 * already-exists 422 for a held one, and the difference said "this email is
 * registered".
 *
 * Credential-only holders — password accounts, admin-created users — keep
 * better-auth's generic answer untouched: the lookup below matches only an
 * `account` row whose `providerId` is neither `credential` nor a stray name
 * the provider table does not know, so an ordinary duplicate-email
 * registration is still refused by better-auth exactly as it always was.
 *
 * Audit posture: like every other auth-family refusal, this writes NOTHING.
 * A thrown before-hook short-circuits the dispatch pipeline before its after
 * half runs, so `auditAuthAfterRequest` never sees the request at all — the
 * same mechanism by which the closed-door sign-in refusal already writes no
 * `auth.sign_in` row.
 */
const GUARDED_PATH = "/sign-up/email";

/**
 * The refusal sentence (exact spelling pinned by the flow test). UI-copy
 * rules: at most two sentences, no em dash; the provider name interpolates
 * the row's `name` verbatim, because that is the label the sign-in page
 * already shows for the same door.
 */
export function heldEmailMessage(providerName: string): string {
  return `An account for this email exists. Sign in with ${providerName}.`;
}

/**
 * The display name of the OIDC door holding `email`, or `undefined` when
 * nobody does or the holder is credential-only.
 *
 * Raw SQL for the same reason as `door-policy.ts`'s `stateByEmail`: the read
 * spans better-auth's `user` and `account` (physical camelCase, outside the
 * typed `Database` builders) and the app's `auth_providers` in one statement.
 *
 * Multiple doors may hold the same address (an arrival that later linked a
 * second one). The pick is the LOWEST matching `providerId` — the SAME
 * ordering rule the approval queue applies (`UsersRepository.listApprovalQueue`
 * / `primaryProviderId` picks MIN(providerId) too), but over a DIFFERENT
 * domain: the queue sorts across the person's providers credential-included,
 * while this lookup answers for configured OIDC doors only. The two lowest
 * ids are therefore not guaranteed to be the same row — what is shared is the
 * tie-break rule, not a shared pick.
 *
 * `providerId <> 'credential'` is the spec's own exclusion (password rows);
 * the JOIN on `auth_providers` is what makes "an OIDC account" mean *a
 * configured door*: a leftover row whose provider was deleted from the table
 * names nothing and falls through to the generic answer. A row that exists
 * but is `enabled = 0` still names its door — disabling a door takes away
 * sign-in availability, not the fact that the address arrived through it,
 * and it is DELETING the row that erases the name to give.
 */
export async function oidcHolderNameByEmail(db: Kysely<Database>, email: string): Promise<string | undefined> {
  if (email === "") return undefined;
  const r = await sql<{ name: string }>`
    SELECT p.name AS name FROM user u
    JOIN account a ON a.userId = u.id
    JOIN auth_providers p ON p.id = a.providerId
    WHERE lower(u.email) = ${email} AND a.providerId <> 'credential'
    ORDER BY a.providerId
    LIMIT 1
  `.execute(db);
  return r.rows[0]?.name;
}

/**
 * Builds the `hooks.before` handler for `/sign-up/email`. The factory exists
 * for the same reason as `createDoorGuardBeforeHook`'s: the check must read
 * the app database LAZILY through the boot-injected handle (`setAuthPolicyDb`),
 * because importing it at module evaluation would break the import-purity
 * invariant (`auth-import-purity.test.ts`). `getDb()` returning `undefined`
 * is the pre-boot gap — allow, like every other policy read answers there.
 *
 * Reads `ctx.body.email` before better-auth validates anything, so an absent
 * or non-string email passes through to better-auth's own `INVALID_EMAIL`
 * rather than becoming this guard's business; the address is normalized the
 * way every other holder lookup in the app normalizes it (`trim` +
 * `toLowerCase`, matching `evaluateDoorPolicy` and `POST /api/users`).
 */
export function createHeldEmailGuardBeforeHook(
  getDb: () => Kysely<Database> | undefined,
): (rawCtx: unknown) => Promise<void> {
  return async (rawCtx: unknown): Promise<void> => {
    const ctx = rawCtx as { path?: unknown; body?: unknown } | null | undefined;
    if (ctx?.path !== GUARDED_PATH) return;
    const db = getDb();
    if (!db) return;
    const body = ctx.body as { email?: unknown } | undefined;
    if (typeof body?.email !== "string") return;
    const email = body.email.trim().toLowerCase();

    // Gate FIRST (spec §5's order, so a closed door never leaks which
    // provider holds an address): the instance's own registration answer,
    // written on the same code and message the door policy already uses —
    // see the module doc for why this must not merely fall through.
    if (!(await registrationOpen(db))) {
      throw new APIError(403, { message: "registration_closed", code: "registration_closed" });
    }

    // Then the named holder. No user row, or a credential-only one: nothing
    // to name, and the request continues down the unchanged path — which is
    // what keeps the first-run wizard (a fresh address, holder-less by
    // definition) and every ordinary duplicate-email refusal exactly as they
    // were.
    const holderName = await oidcHolderNameByEmail(db, email);
    if (holderName === undefined) return;
    throw new APIError(403, { message: heldEmailMessage(holderName) });
  };
}
