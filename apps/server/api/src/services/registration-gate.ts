import type { Kysely } from "kysely";
import type { Database } from "@/db/types/index.js";

/** The `settings` row; absent has a meaning of its own — see below. */
export const ALLOW_REGISTRATIONS_KEY = "allow_registrations";

/**
 * The `settings` row governing who may add a node.
 *
 * Here rather than in `api/settings.route.ts` because two modules read it —
 * the settings routes and `api/nodes/create-setup-key.route.ts` — and the
 * repo's precedent for a settings key with more than one reader is
 * `INSTANCE_NAME_KEY` in a service, not a route. A nodes route importing a
 * route module to get a string pulls that route's whole Elysia graph in with
 * it.
 *
 * An ABSENT row means true, like `allow_registrations` before a user exists:
 * an instance that has never touched this keeps the behaviour it had, where
 * any signed-in user could mint a setup key.
 */
export const ALLOW_NODE_ENROLLMENT_KEY = "allow_node_enrollment";

/**
 * Whether this instance currently accepts a new sign-up.
 *
 * **One function, because three surfaces have to agree**: better-auth's own
 * `before` hook refuses the POST, `GET /api/settings` draws the admin's
 * switch, and `GET /api/settings/public` decides whether the sign-in page
 * offers a "create an account" link. Reading the row independently is how a
 * page ends up saying "Open" on an instance that refuses every sign-up.
 *
 * It FAILS CLOSED (security audit 2026-08, F6a): only a parseable JSON `true`
 * opens it. An unparseable or non-boolean value reads as closed, because
 * treating corruption as open turns a damaged settings row into silently
 * re-opened registration on a locked-down instance.
 *
 * **An absent row is CLOSED, except while the instance has no users at all**
 * (2026-09-13). The default used to be open unconditionally, so every
 * instance shipped accepting sign-ups from anyone who could reach it until an
 * admin noticed. The permissive state should be the one an operator chooses.
 *
 * The exception is what makes that default possible rather than a softening
 * of it: the FIRST account registered becomes the admin, so a closed instance
 * with nobody in it could never mint the one person able to open it — a fresh
 * install would be bricked behind a sign-up form that refuses. The door is
 * open exactly until someone walks through it, and closes behind them.
 *
 * @param db - the app database
 */
export async function registrationOpen(db: Kysely<Database>): Promise<boolean> {
  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", ALLOW_REGISTRATIONS_KEY)
    .executeTakeFirst();
  // The row is only consulted for users when it is ABSENT, so the count is
  // not paid on an instance that has answered the question.
  return registrationDecision(row?.value, row ? false : await hasAnyUser(db));
}

/**
 * The rule itself, with no database in it.
 *
 * Split out so it is testable without a users table: the suite shares one
 * database across files, so a test asserting "no users" against the real
 * count passes alone and fails beside any test that registers someone. That
 * is the same parallel-global-state trap that has bitten this repo twice
 * already, and the fix is the same — take the fact as an argument.
 *
 * @param stored - the raw `settings.value`, or undefined when no row exists
 * @param hasUsers - whether anyone has registered; read only when `stored` is
 *                   undefined, and ignored otherwise
 */
export function registrationDecision(stored: string | undefined, hasUsers: boolean): boolean {
  if (stored !== undefined) {
    try {
      return (JSON.parse(stored) as unknown) === true;
    } catch {
      return false;
    }
  }
  return !hasUsers;
}

/**
 * Whether anybody has registered yet.
 *
 * `user_meta` is the instance's "a user exists" truth — the same row set
 * `GET /api/setup/status` counts for `hasUsers`, so the first-run window and
 * this gate open and close together rather than by two different measures.
 */
export async function hasAnyUser(db: Kysely<Database>): Promise<boolean> {
  const row = await db
    .selectFrom("userMeta")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count) > 0;
}
