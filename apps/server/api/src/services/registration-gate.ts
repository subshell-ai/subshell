import type { Kysely } from "kysely";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { Database } from "@/db/types/index.js";

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
 * An ABSENT row means true: an instance that has never touched this keeps the
 * behaviour it had, where any signed-in user could mint a setup key. (The
 * registration switch this sits beside no longer lives in the `settings`
 * table at all — {@link registrationOpen} explains where it moved.)
 */
export const ALLOW_NODE_ENROLLMENT_KEY = "allow_node_enrollment";

/**
 * Whether this instance currently accepts a NEW E-MAIL sign-up — i.e. the
 * E-mail provider row's `registration_enabled` (spec 2026-09-24 §2). NULL on
 * that row means the legacy dynamic window: open exactly while no real
 * account exists, closed behind the first one. OIDC doors answer their own
 * `registration_enabled` in `auth/door-policy.ts`; this function is the one
 * answer three surfaces share (the sign-up hook, the settings read, the
 * Auth page's E-mail row).
 *
 * **One function, because those surfaces have to agree**: better-auth's own
 * `before` hook refuses the POST, `GET /api/settings` draws the admin's
 * switch, and `GET /api/settings/public` decides whether the sign-in page
 * offers a "create an account" link. Reading the row independently is how a
 * page ends up saying "Open" on an instance that refuses every sign-up.
 *
 * It FAILS CLOSED (security audit 2026-08, F6a, carried across): only the
 * value 1 opens; anything else stored — 0, a hand-edited non-number — reads
 * closed, because treating corruption as open turns a damaged row into
 * silently re-opened registration on a locked-down instance.
 *
 * **NULL is CLOSED, except while the instance has no users at all** (the
 * 2026-09-13 default, which the NULL-means-legacy encoding preserves, so a
 * static default could not freeze the first-run window open — migration
 * 0037 §2). The exception is what makes that default possible rather than a
 * softening of it: the FIRST account registered becomes the admin, so a
 * closed instance with nobody in it could never mint the one person able to
 * open it — a fresh install would be bricked behind a sign-up form that
 * refuses. The door is open exactly until someone walks through it, and
 * closes behind them.
 *
 * The legacy `allow_registrations` settings row this gate used to read — and
 * which the settings PATCH used to write — now has NO reader and no writer:
 * migration 0037 spells its key inline for the copy-forward and the PATCH
 * lands on this row (spec 2026-09-24 §2). The audit trail keeps spelling that
 * key as its `targetId`, as the switch's stable name.
 *
 * @param db - the app database
 */
export async function registrationOpen(db: Kysely<Database>): Promise<boolean> {
  const row = await new AuthProvidersRepository(db).getById("email");
  const stored = row?.registrationEnabled ?? null;
  if (stored !== null) return emailRegistrationDecision(stored, false);
  // The legacy window: the count is paid only when nothing answers.
  return emailRegistrationDecision(null, await hasAnyUser(db));
}

/**
 * The rule with no database in it — same parallel-state reasoning as the
 * settings-row rule it replaced: the suite shares one database across files,
 * so a test asserting "no users" against the real count passes alone and
 * fails beside any test that registers someone. Take the fact as an argument.
 *
 * @param stored - the E-mail provider row's `registration_enabled`, or null
 *                 when it answers nothing (the legacy dynamic window)
 * @param hasUsers - whether anyone has registered; read only when `stored`
 *                   is null, and ignored otherwise
 */
export function emailRegistrationDecision(stored: number | null, hasUsers: boolean): boolean {
  if (stored !== null) return stored === 1; // 0 and anything-not-1 read closed
  return !hasUsers;
}

/**
 * Whether anybody has registered yet.
 *
 * ONE counter — {@link UsersRepository.countRealAccounts} — shared with
 * `GET /api/setup/status`'s `hasUsers` and the boot handoff line, so the
 * first-run window, the line telling an operator to open it, and this gate
 * cannot answer differently.
 *
 * It counts ACCOUNTS, not `user_meta` rows. That table is a role side-table
 * written by a separate hook and it diverges from `user` in practice (the
 * system service account has no meta row at all); a user row whose meta row
 * is missing used to read here as an empty instance, which reopens
 * registration on an instance that has real accounts. The repository's
 * docstring carries the full accounting.
 */
export async function hasAnyUser(db: Kysely<Database>): Promise<boolean> {
  return (await new UsersRepository(db).countRealAccounts()) > 0;
}
