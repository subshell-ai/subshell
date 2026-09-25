import type { Kysely } from "kysely";
import { sql } from "kysely";
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
 * It reads the raw `settings` row rather than `SettingsRepository.get`,
 * because `get` swallows the `JSON.parse` failure into the fallback — the
 * brief's "corrupt ⇒ 30 WITH a warn" requires seeing the unparseable case
 * separately from the absent one. Absent stays silent (it is the normal
 * state); present-but-undecodable is not, and says so.
 *
 * @param db - the app database
 */
export async function expiryDays(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", PENDING_APPROVAL_EXPIRY_KEY)
    .executeTakeFirst();
  if (!row) return DEFAULT_PENDING_APPROVAL_EXPIRY_DAYS;
  let raw: unknown;
  try {
    raw = JSON.parse(row.value) as unknown;
  } catch {
    logger.warn(
      `pending approvals: settings row ${PENDING_APPROVAL_EXPIRY_KEY} is not JSON; ` +
        `expiring after ${DEFAULT_PENDING_APPROVAL_EXPIRY_DAYS} days instead`,
    );
    return DEFAULT_PENDING_APPROVAL_EXPIRY_DAYS;
  }
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
 * §6 lifecycle says so: an open Google provider means anyone can knock, so the
 * queue "must not be an unbounded junkyard"). A knocked-and-forgotten
 * person who returns simply re-arrives on a fresh row.
 *
 * **Rejected rows never expire**, and that asymmetry is load-bearing: a
 * rejection is an explicit admin decision, and letting it age out on a
 * timer would silently reopen the provider nobody reopened. Dedup-by-email
 * keeps repeat knockers on their one row, so there is no pile-up to fear.
 * (An approved or absent row is a member and is out of scope entirely; a
 * `pending` row with a NULL clock has nothing to age against and survives
 * until its next knock re-stamps it — `setApproval` always stamps on entry,
 * so that state only arises from a hand edit.)
 *
 * ONE transaction: select the ids, refuse the ones that own anything, then
 * delete each remaining user's rows from every table that can hold one —
 * `user_meta` (typed), better-auth's `session`, `verification` and
 * `account`, the user-owned config rows `device_tokens` and `favorites`
 * (measured: they own nothing live, so they cascade here rather than joining
 * the refusal set — see the delete site), then `user` (raw SQL with the
 * physical camelCase names per the plugin-bypass rule; `verification`
 * carries no userId column, so
 * `identifier` is the only principal handle it can match — and NOTE that no
 * current better-auth writer spells `identifier` as a userId (email-verify,
 * password-reset and account-delete tokens all put an email or a token
 * there, checked against the installed 1.7.1), so this clause is stated
 * defense for an id-shaped row, not a live path). The session/verification
 * deletes are DEFENSIVE — a pending person never had a session, but the
 * sweep must not depend on that being true (§6), and the FK cascade is not
 * relied on either: the pragma being on is an `open-database` detail, and a
 * sweep whose correctness lived there would be one connection-flag away
 * from orphaning accounts.
 *
 * **An expired pending row that OWNS anything is refused, not deleted**
 * (Task 10 review, finding 1). Under correct marking this state is
 * impossible: a pending arrival never gets a session (`session.create.before`
 * + `validateUserInfo`), and an ownerless human creates no subshells, nodes
 * or workspaces. So ownership on a pending row testifies that the
 * failed-mark path was live — exactly what the re-mark pass repairs while
 * the clock is fresh, and anything still pending-and-owning past the expiry
 * window is beyond a sweep's right to guess with. Deleting it would orphan
 * those owner refs (none carry an FK back) and would leave an enrolled
 * node's socket answering `accountDisabled` for a row that no longer
 * exists. The rows stay `pending`, every hour loudly, until a human acts;
 * "unresolvable states are asked about, never asserted away" is the same
 * posture the live-feed revocation already holds. The three ownership
 * probes run per sweep (not per candidate): the queue is tiny by §6's own
 * dedup rule, and one `IN`-list query per table keeps the check inside the
 * same transaction as the deletes it gates.
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

    // Ownership refusal (finding 1 above): a pending row owning ANY of the
    // three user-owned tables stays. Typed reads — every table here is an
    // app table, so the plugin spells the physical names from these fields.
    const subshellOwners = await trx
      .selectFrom("subshells")
      .select("userId")
      .distinct()
      .where("userId", "in", ids)
      .execute();
    const nodeOwners = await trx
      .selectFrom("nodes")
      .select("ownerUserId")
      .distinct()
      .where("ownerUserId", "in", ids)
      .execute();
    const workspaceOwners = await trx
      .selectFrom("workspaces")
      .select("userId")
      .distinct()
      .where("userId", "in", ids)
      .execute();
    const owned = new Set<string>([
      ...subshellOwners.map((row) => row.userId),
      ...nodeOwners.map((row) => row.ownerUserId),
      ...workspaceOwners.map((row) => row.userId),
    ]);
    const refused = ids.filter((id) => owned.has(id));
    const doomed = ids.filter((id) => !owned.has(id));
    if (refused.length > 0) {
      logger.warn(
        `pending approvals: expiry REFUSED for ${refused.join(", ")} — pending rows that own ` +
          `subshells/nodes/workspaces cannot have arrived cleanly; an admin must resolve these by hand`,
      );
    }
    if (doomed.length === 0) return 0;

    const list = sql.join(doomed.map((id) => sql`${id}`));
    await sql`DELETE FROM session WHERE userId IN (${list})`.execute(trx);
    await sql`DELETE FROM verification WHERE identifier IN (${list})`.execute(trx);
    await sql`DELETE FROM account WHERE userId IN (${list})`.execute(trx);
    // The two USER-OWNED CONFIG artifacts a failed-mark arrival (the only
    // class that ever held a session) could have created — final review,
    // minor. They join the DELETE set, NOT the refusal set: the refused
    // class (subshells/nodes/workspaces) is rows that own LIVE things, and a
    // person with no subshells receiving no pushes owns nothing in a device
    // token; the enrollment path already re-claims a token by deleting its
    // old owner's row first (`device-tokens.repository.ts`), and a favorite
    // with no owner is inert. Orphaning them is dead weight with a globally
    // unique plaintext token riding in it; refusing would strand the pending
    // row in the hourly warn over zero blast radius. These deletes are the
    // cascade the absent FKs would have been (the same argument §6 makes for
    // deleting account/session rows explicitly).
    await trx.deleteFrom("deviceTokens").where("userId", "in", doomed).execute();
    await trx.deleteFrom("favorites").where("userId", "in", doomed).execute();
    await sql`DELETE FROM user WHERE id IN (${list})`.execute(trx);
    await trx.deleteFrom("userMeta").where("userId", "in", doomed).execute();
    return doomed.length;
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
 *   who linked the gated provider beside a second account is not an arrival);
 * - that account's `providerId` names an `auth_providers` row with
 *   `require_approval = 1`, and is not `credential` — mirroring the hook's
 *   `getById` + skip guard exactly, email-provider sign-ups included;
 * - that provider row was last updated AT OR BEFORE the user's `createdAt`
 *   (Task 10 review, guard 6): a `require_approval` flip landed AFTER a
 *   person arrived cannot retroactively queue — and DEMOTE — them. The
 *   sharp case is concrete: an instance whose first admin walked through a
 *   then-open provider, an admin later flips approval on, and without this
 *   clause the next sweep demotes the sole admin and re-queues them,
 *   bricking the instance against its own policy. (The clause reads the
 *   provider's `updated_at` through SQLite `datetime()` because the two tables
 *   spell time differently — see the query.) A hand-SQL flip that never
 *   bumps `updated_at` stays outside the guard's reach, like every other
 *   hand edit this service only bounds conservatively;
 * - `approvalState` reads APPROVED, asked through `UserMetaRepository` so
 *   the absent-row and hand-edit rules live in one reader (an absent row —
 *   both after-hooks missed — counts as approved too);
 * - **no `user.approve` audit row targets the user**, and
 * - the user's `createdAt` is within {@link ARRIVAL_REMARK_WINDOW_MS} —
 *   anything older is established membership regardless of current policy,
 *   and the window is also the belt against old accounts whose meta row was
 *   hand-deleted. The window has a stated cost: a server blackout longer
 *   than it permanently skips the repair, and the hook's `logger.error` at
 *   arrival time is then the only trace that the marking was ever lost —
 *   accepted, because widening the window is exactly how the sweep starts
 *   fighting recent human decisions.
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
  // The provider-vs-user timestamp gate compares through `datetime()` because
  // the two sides do not carry the SAME spelling of time: `auth_providers`
  // is an app table whose row-creation default is `datetime('now')`
  // (second-precise, space-separated), the repo's own `update` rewrites it
  // as a full ISO string, and better-auth's `user.createdAt` is ISO with
  // milliseconds and a Z. A raw lexicographic `<=` would read every
  // space-separated stamp of the SAME DAY as less than an ISO one (space
  // sorts before `T`), which is exactly the day that a flip must be caught
  // on; `datetime()` normalizes both spellings to second-precise UTC.
  const candidates = await sql<{ userId: string; providerId: string }>`
    SELECT u.id AS userId, a.providerId AS providerId
    FROM user u
    JOIN account a ON a.userId = u.id
    JOIN auth_providers p ON p.id = a.providerId
    WHERE a.providerId <> 'credential'
      AND p.require_approval = 1
      AND datetime(p.updated_at) <= datetime(u."createdAt")
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
    // The repair is ONE transaction (review finding 2): mark, demote and
    // revoke are three writes over state the next pass cannot re-derive —
    // a death between `setApproval` and the demote would leave permanent
    // pending+ADMIN (invisible to this pass, whose gate wants `approved`)
    // and the next approval would mint a privileged member from it. And
    // finding 1: the re-mark must take back the ACCESS, not just the queue
    // row — a failed-mark arrival minted a real session (it read `approved`
    // at `session.create.before`, and the auth guard does not re-ask
    // pending), so leaving those rows alive would hand a re-queued person
    // member access until each expires. Same raw-SQL revoke as
    // `setDisabled`, count included, for the journal line.
    const revokedSessions = await db.transaction().execute(async (trx) => {
      const tmeta = new UserMetaRepository(trx);
      // The expiry clock starts HERE, at repair time: the row never had one
      // (correct marking stamps on entry, the failed one never got there),
      // and re-mark time is the honest start of this arrival's expiry
      // window — §6's days count from when the queue actually saw it.
      await tmeta.setApproval(candidate.userId, "pending", { arrivedAt: new Date().toISOString() });
      await tmeta.demoteAdminIfAutoPromoted(candidate.userId);
      const counted = await sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM session WHERE userId = ${candidate.userId}`.execute(trx);
      await sql`DELETE FROM session WHERE userId = ${candidate.userId}`.execute(trx);
      return Number(counted.rows[0]?.n ?? 0);
    });
    remarked += 1;
    logger.warn(
      `provider policy: re-queued unmarked arrival user ${candidate.userId} on provider ${candidate.providerId} — ` +
        `account.create.after's marking was lost; the account is pending again and ${revokedSessions} session(s) were revoked`,
    );
  }
  return remarked;
}
