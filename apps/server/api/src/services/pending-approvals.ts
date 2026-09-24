import type { Kysely } from "kysely";
import { sql } from "kysely";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { Database } from "@/db/types/index.js";
import { logger } from "@/utils/logger.js";

/**
 * The `settings` row behind PENDING APPROVAL EXPIRY (spec 2026-09-24 §6):
 * how many days an unactioned `pending` arrival waits before the hourly
 * sweep deletes it. Admin-set on Settings → Auth; `0` means keep forever —
 * the log-retention idiom. A service module rather than a route constant
 * because the sweep reads it now and the settings route writes it, exactly
 * like `LOCKDOWN_KEY`.
 */
export const PENDING_APPROVAL_EXPIRY_KEY = "pending_approval_expiry_days";

/** The default when no row exists: 30 days (spec 2026-09-24 §6). */
export const DEFAULT_PENDING_APPROVAL_EXPIRY_DAYS = 30;

/**
 * How far back the re-mark pass looks for arrivals (see
 * {@link remarkUnmarkedArrivals}). Two hours, because the pass itself runs
 * hourly: the window has to cover at least one full cadence plus clock skew,
 * and every hour it widens, it widens into "recent members whose admin was
 * slow" — the false-positive direction the rule below refuses to walk.
 */
const ARRIVAL_REMARK_WINDOW_MS = 2 * 3_600_000;

const MS_PER_DAY = 86_400_000;

/**
 * The configured expiry window in days. The absent-rows-default idiom
 * {@link lockdownEnabled} uses, with one addition the number deserves: a
 * row that is present but not a non-negative integer day count is corrupt,
 * and corrupt falls back to the default WITH A WARN — silently expiring a
 * queue on a damaged row and silently never expiring one are both worse
 * than the default with a loud line in the journal.
 *
 * @param db - the app database
 */
export async function expiryDays(db: Kysely<Database>): Promise<number> {
  const raw = await new SettingsRepository(db).get<unknown>(
    PENDING_APPROVAL_EXPIRY_KEY,
    DEFAULT_PENDING_APPROVAL_EXPIRY_DAYS,
  );
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  logger.warn(
    `pending approvals: settings row ${PENDING_APPROVAL_EXPIRY_KEY} is not a day count (${JSON.stringify(raw)}); ` +
      `expiring after ${DEFAULT_PENDING_APPROVAL_EXPIRY_DAYS} days instead`,
  );
  return DEFAULT_PENDING_APPROVAL_EXPIRY_DAYS;
}

/**
 * Delete `pending` arrivals whose queue clock is older than
 * {@link expiryDays} (spec 2026-09-24 §6). Returns the number of USERS
 * deleted. `expiryDays` of `0` means keep forever and deletes nothing.
 *
 * **Why deletion is legitimate here when "user deletion does not exist"
 * elsewhere**: that rule shields MEMBERS — accounts someone was admitted
 * as. A `pending` row is nobody's membership; it is a knock that was never
 * opened (the person holds no session, owns no data, and the spec's own
 * §6 lifecycle says so: an open Google door means anyone can knock, so the
 * queue "must not be an unbounded junkyard"). A knocked-and-forgotten
 * person who returns simply re-arrives on a fresh row.
 *
 * **Rejected rows never expire**, and that asymmetry is load-bearing: a
 * rejection is an explicit admin decision, and letting it age out on a
 * timer would silently reopen the door nobody reopened. Dedup-by-email
 * keeps repeat knockers on their one row, so there is no pile-up to fear.
 * (An approved or absent row is a member and is out of scope entirely; a
 * `pending` row with a NULL clock has nothing to age against and survives
 * until its next knock re-stamps it — `setApproval` always stamps on entry,
 * so that state only arises from a hand edit.)
 *
 * ONE transaction: select the ids, then delete each user's rows from every
 * table that can hold one — `user_meta` (typed), then better-auth's
 * `session`, `verification` and `account`, then `user` (raw SQL with the
 * physical camelCase names per the plugin-bypass rule; `verification`
 * carries no userId column, so `identifier` is the only principal handle it
 * can match). The session/verification deletes are DEFENSIVE — a pending
 * person never had a session, but the sweep must not depend on that being
 * true (§6), and the FK cascade is not relied on either: the pragma being
 * on is an `open-database` detail, and a sweep whose correctness lived
 * there would be one connection-flag away from orphaning accounts.
 *
 * @param db - the app database
 * @returns the number of expired pending users deleted
 */
export async function expirePendingApprovals(db: Kysely<Database>): Promise<number> {
  const days = await expiryDays(db);
  if (days === 0) return 0; // keep forever: no transaction, no reads, no deletes
  const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString();
  return await db.transaction().execute(async (trx) => {
    // ISO-8601 UTC strings sort lexicographically, so `< cutoff` is a true
    // time comparison; the clock column is written only by `setApproval`
    // and `touchPendingArrivedByEmail`, both `toISOString`.
    const rows = await trx
      .selectFrom("userMeta")
      .select("userId")
      .where("approvalState", "=", "pending")
      .where("pendingArrivedAt", "is not", null)
      .where("pendingArrivedAt", "<", cutoff)
      .execute();
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.userId);
    const list = sql.join(ids.map((id) => sql`${id}`));
    await sql`DELETE FROM session WHERE userId IN (${list})`.execute(trx);
    await sql`DELETE FROM verification WHERE identifier IN (${list})`.execute(trx);
    await sql`DELETE FROM account WHERE userId IN (${list})`.execute(trx);
    await sql`DELETE FROM user WHERE id IN (${list})`.execute(trx);
    await trx.deleteFrom("userMeta").where("userId", "in", ids).execute();
    return ids.length;
  });
}

/**
 * Re-queue arrivals that `account.create.after` failed to mark (Task 6
 * review finding I2) — the compensation the hook's docstring promised
 * ("the compensating sweep-check lands with the expiry pass"). The hook
 * runs AFTER its transaction commits, so a throw there leaves the user
 * created, promoted (if first), and APPROVED — no later seam ever re-fires
 * the marking, because the person's next knock takes the sign-in path.
 * Without this pass, a marking failure is a silently unapproved person with
 * admin-shaped privileges.
 *
 * **The false-positive direction is the dangerous one twice over**: an
 * admin turning `require_approval` ON later must NOT retroactively
 * un-approve established members, and a sweep must NEVER undo an approval
 * an admin made minutes ago — the sweep fighting a human is the worse bug
 * class next to the hole it patches. So a row is re-marked only when ALL of:
 *
 * - exactly ONE `account` row — the same links-are-not-arrivals test the
 *   hook applies (`accountCount = 1`, counted over ALL accounts, so a user
 *   who linked the gated door beside a second account is not an arrival);
 * - that account's `providerId` names an `auth_providers` row with
 *   `require_approval = 1`, and is not `credential` — mirroring the hook's
 *   `getById` + skip guard exactly, email-door sign-ups included;
 * - `approvalState` reads APPROVED, asked through `UserMetaRepository` so
 *   the absent-row and hand-edit rules live in one reader (an absent row —
 *   both after-hooks missed — counts as approved too);
 * - **no `user.approve` audit row targets the user**, and
 * - the user's `createdAt` is within {@link ARRIVAL_REMARK_WINDOW_MS} —
 *   anything older is established membership regardless of current policy,
 *   and the window is also the belt against old accounts whose meta row was
 *   hand-deleted.
 *
 * **Why the audit trail and not row-absence is the human-spoke signal:**
 * a failed marking does NOT leave no row — `user.create.after`'s
 * `promoteFirstUserAtomically` INSERTs the `user_meta` row for EVERY user
 * creation (winners `admin`, losers `user`), and it runs before the account
 * row exists, hence before the marking hook. So the normal failed-mark
 * shape is a PRESENT row reading `approved` with a NULL clock — the exact
 * bytes an approval leaves. What distinguishes them is the audit trail:
 * `PATCH /api/users/:id/approval` is the only writer of the approved edge
 * (it 409s onto an already-approved row), and every approval writes
 * `user.approve`. Row present + approved + NO audit trail ⇒ the marking
 * was lost, re-queue. Approved + an audit trail ⇒ a human said yes, hands
 * off. A row-absent user can carry no approval trail, so it falls to the
 * same branch and the rule reads uniformly.
 *
 * The residual risk is honest: `audit()` is best-effort and never throws,
 * so an approval whose audit row was LOST degrades to the pre-fix behavior
 * (re-queued within the window, stickable by re-approval). That is strictly
 * rarer than the defect this closes, and closing it fully would mean the
 * sweep trusting nothing but the trail.
 *
 * Re-marking runs the hook's exact pair (`setApproval(pending)` then
 * {@link UserMetaRepository.demoteAdminIfAutoPromoted}), which is what
 * makes the demote safe here and keeps it REACHABLE: the normal
 * failed-mark shape is precisely the auto-promoted one (promotion wrote
 * `admin`, marking threw), and the demote's `WHERE role = 'admin'` clause
 * only ever matches a role `promoteFirstUserAtomically` wrote minutes ago
 * for a genuine arrival — its JSDoc's "never observable by anyone"
 * argument holds identically for a marking this pass repairs.
 *
 * **No audit row for the re-mark itself** — per finding I2's posture this
 * stays a `logger.warn`: it is not an admin act and not a user act, it is
 * this process repairing its own failed write, and the journal line is
 * what makes it loud. (Deliberately unlike the approval routes, which
 * audit because a human decided something.)
 *
 * @param db - the app database
 * @returns the number of arrivals re-marked pending
 */
export async function remarkUnmarkedArrivals(db: Kysely<Database>): Promise<number> {
  const windowStart = new Date(Date.now() - ARRIVAL_REMARK_WINDOW_MS).toISOString();
  // Raw SQL: this spans better-auth's `user`/`account` (physical camelCase)
  // and the app's `auth_providers` (physical snake_case). The correlated
  // subquery counts ALL of the user's accounts, while the joins below only
  // ever MATCH the gated one — a two-account user must fail the count even
  // though only one row joins. Result aliases pass through the
  // CamelCasePlugin's camelize, so plain identifiers read back unchanged.
  const candidates = await sql<{ userId: string; providerId: string }>`
    SELECT u.id AS userId, a.providerId AS providerId
    FROM user u
    JOIN account a ON a.userId = u.id
    JOIN auth_providers p ON p.id = a.providerId
    WHERE a.providerId <> 'credential'
      AND p.require_approval = 1
      AND u."createdAt" > ${windowStart}
      AND (SELECT COUNT(*) FROM account a2 WHERE a2.userId = u.id) = 1
  `.execute(db);

  const meta = new UserMetaRepository(db);
  let remarked = 0;
  for (const candidate of candidates.rows) {
    // The single reader owns "approved" here — absent row, default column
    // value and hand-edited junk all read approved, pending/rejected don't.
    if ((await meta.approvalState(candidate.userId)) !== "approved") continue;
    // The human-spoke signal: `PATCH /api/users/:id/approval` is the only
    // writer of the approved edge and it always leaves this trail behind.
    // Typed read — `audit_events` is an app table (the CamelCasePlugin
    // spells its snake_case physical names from these camelCase fields).
    const approvedByHuman = await db
      .selectFrom("auditEvents")
      .select("id")
      .where("action", "=", "user.approve")
      .where("targetType", "=", "user")
      .where("targetId", "=", candidate.userId)
      .executeTakeFirst();
    if (approvedByHuman) continue;
    await meta.setApproval(candidate.userId, "pending", { arrivedAt: new Date().toISOString() });
    await meta.demoteAdminIfAutoPromoted(candidate.userId);
    remarked += 1;
    logger.warn(
      `door policy: re-queued unmarked arrival user ${candidate.userId} on provider ${candidate.providerId} — ` +
        `account.create.after's marking was lost; the account is now pending again`,
    );
  }
  return remarked;
}
