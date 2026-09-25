import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import { type ApprovalState, asApprovalState } from "@/db/types/approval-state.js";
import { asSetupStep, type SetupStep } from "@/db/types/setup-step.js";
import type { NewUserMeta } from "@/db/types/user-meta.db-types.js";
import type { UserRole } from "@/db/types/user-role.js";

/**
 * The outcome of {@link UserMetaRepository.setDisabled}: either the write
 * landed and says how many sessions it cut, or it was refused because the
 * target is the only admin who can still sign in.
 */
export type SetDisabledResult = { ok: true; sessionsRevoked: number } | { ok: false; reason: "last_admin" };

/**
 * Repository for extra user metadata (roles). The first user to register
 * becomes admin; later registrations default to "user".
 */
export class UserMetaRepository extends BaseRepository {
  async upsert(user: NewUserMeta): Promise<void> {
    await this.db
      .insertInto("userMeta")
      .values(user)
      .onConflict((oc) =>
        oc.column("userId").doUpdateSet({
          role: user.role,
        }),
      )
      .execute();
  }

  /**
   * Sets a user's role, refusing to remove the LAST admin.
   *
   * The count and the write are one transaction, and that is the whole reason
   * this lives in the repository rather than as a check in the route: two
   * admins demoting each other concurrently would otherwise both read "2
   * admins", both pass, and leave an instance nobody can administer — no role
   * changes, no user creation, no system keys, no settings, recoverable only
   * through `SUBSHELL_EMERGENCY_PASSWORD` and a restart.
   *
   * What makes one transaction SUFFICIENT here is a property of the dialect
   * rather than of this code, so it is worth stating: `bun:sqlite` is
   * synchronous and Kysely's dialect hands out ONE shared connection, so the
   * awaits below never yield between the SELECT and the write, and concurrent
   * calls serialize in practice. Measured, not assumed — the route test fires
   * eight demotions at once and asserts exactly one admin survives and nothing
   * throws. Should the dialect ever become genuinely async or pooled, that
   * test fails first, and this method would then need an application-level
   * mutex.
   *
   * Self-demotion is allowed and deliberately not special-cased: an admin
   * stepping down while others remain is legitimate, and the last-admin rule
   * already covers the only case that matters.
   *
   * @returns `false` when the change was refused as the last admin's demotion
   */
  async setRole(userId: string, role: UserRole): Promise<boolean> {
    return await this.db.transaction().execute(async (trx) => {
      if (role !== "admin") {
        const current = await trx.selectFrom("userMeta").select("role").where("userId", "=", userId).executeTakeFirst();
        // Only a demotion OF an admin can strand the instance; promoting or
        // re-writing a non-admin's role never can.
        if (current?.role === "admin") {
          const { admins } = await trx
            .selectFrom("userMeta")
            .select((eb) => eb.fn.countAll<number>().as("admins"))
            .where("role", "=", "admin")
            .executeTakeFirstOrThrow();
          if (Number(admins) <= 1) return false;
        }
      }
      await trx
        .insertInto("userMeta")
        .values({ userId, role })
        .onConflict((oc) => oc.column("userId").doUpdateSet({ role }))
        .execute();
      return true;
    });
  }

  /**
   * Whether this account is disabled. An absent `user_meta` row reads as
   * ENABLED, like the column's own default — a user minted before the column
   * existed must not be locked out by an upgrade.
   *
   * On the hot path: `authGuard` asks this on every authenticated request, so
   * it stays one indexed lookup by primary key.
   *
   * @param userId - better-auth user id
   */
  async isDisabled(userId: string): Promise<boolean> {
    const row = await this.db.selectFrom("userMeta").select("disabled").where("userId", "=", userId).executeTakeFirst();
    return (row?.disabled ?? 0) !== 0;
  }

  /**
   * Disables or re-enables an account, revoking every session it holds when
   * it is disabled.
   *
   * The count, the flag write and the revocation are ONE transaction, for the
   * two reasons the neighbouring guards have:
   *
   * - a disable that leaves live cookies behind does nothing — the point of
   *   the flag is that the account stops authenticating, and someone already
   *   holding a session would keep working until it expired;
   * - two concurrent disables of the last two enabled admins must not both
   *   read "2" and both pass, which would leave an instance nobody can
   *   administer. The guard counts admins who are ENABLED, since a disabled
   *   admin cannot administer anything. Same dialect argument as
   *   {@link setRole}: `bun:sqlite` is synchronous over one shared
   *   connection, so these transactions serialize in practice.
   *
   * Re-enabling is never refused: it can only widen access, and undoing a
   * disable has to stay possible unconditionally.
   *
   * Upserts for the same reason {@link setNotifyEnabled} does — a user whose
   * `user_meta` row was never created still has to be disableable; `role`
   * is only used when the row is being created and matches the DB default.
   *
   * @returns the sessions cut, or a refusal naming the last-enabled-admin rule
   */
  async setDisabled(userId: string, disabled: boolean): Promise<SetDisabledResult> {
    const flag = disabled ? 1 : 0;
    return await this.db.transaction().execute(async (trx) => {
      if (disabled) {
        const current = await trx
          .selectFrom("userMeta")
          .select(["role", "disabled"])
          .where("userId", "=", userId)
          .executeTakeFirst();
        // Only disabling an admin who can still sign in removes an
        // administrator; re-disabling one who is already disabled changes
        // nothing and must not be refused.
        if (current?.role === "admin" && current.disabled === 0) {
          const { admins } = await trx
            .selectFrom("userMeta")
            .select((eb) => eb.fn.countAll<number>().as("admins"))
            .where("role", "=", "admin")
            .where("disabled", "=", 0)
            .executeTakeFirstOrThrow();
          if (Number(admins) <= 1) return { ok: false, reason: "last_admin" } as const;
        }
      }
      await trx
        .insertInto("userMeta")
        .values({ userId, role: "user", disabled: flag })
        .onConflict((oc) => oc.column("userId").doUpdateSet({ disabled: flag }))
        .execute();
      if (!disabled) return { ok: true, sessionsRevoked: 0 } as const;
      // better-auth's `session` table is outside the typed Database, so raw
      // sql with its literal camelCase column — the same shape
      // `UsersRepository.setPassword` uses for exactly this revocation.
      const counted = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM session WHERE userId = ${userId}`.execute(trx);
      await sql`DELETE FROM session WHERE userId = ${userId}`.execute(trx);
      return { ok: true, sessionsRevoked: Number(counted.rows[0]?.n ?? 0) } as const;
    });
  }

  /**
   * The wizard's resume bookmark for this user (spec 2026-09-16), or `null`
   * when there is none — an absent row, a NULL column, or a stored value
   * outside the {@link SetupStep} enum all read the same way.
   *
   * The enum narrowing on read is the fail-safe half of the design: nothing
   * acts on this value but a redirect, so a hand-edited string must read as
   * "no bookmark" rather than become a step the wizard cannot render.
   *
   * @param userId - better-auth user id
   */
  async getSetupStep(userId: string): Promise<SetupStep | null> {
    const row = await this.db
      .selectFrom("userMeta")
      .select("setupStep")
      .where("userId", "=", userId)
      .executeTakeFirst();
    return asSetupStep(row?.setupStep);
  }

  /**
   * Writes (or, with `null`, clears) the wizard's resume bookmark. Upserts for
   * the same reason {@link setNotifyEnabled} does — a user whose `user_meta`
   * row was never created still has to be bookmarkable — and `role` falls back
   * to its DB default on insert only, never touching an existing row's role.
   *
   * @param userId - better-auth user id
   * @param step - the step to remember, or `null` to clear the bookmark
   */
  async setSetupStep(userId: string, step: SetupStep | null): Promise<void> {
    await this.db
      .insertInto("userMeta")
      .values({ userId, role: "user", setupStep: step })
      .onConflict((oc) => oc.column("userId").doUpdateSet({ setupStep: step }))
      .execute();
  }

  async getRole(userId: string): Promise<string | null> {
    const row = await this.db.selectFrom("userMeta").select("role").where("userId", "=", userId).executeTakeFirst();
    return row?.role ?? null;
  }

  /**
   * Whether this user receives subshell notifications (the master switch). A
   * missing row or the column default reads as enabled — notifications are on
   * by default (spec 2026-08-31).
   * @param userId - better-auth user id
   */
  async getNotifyEnabled(userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("userMeta")
      .select("notifyEnabled")
      .where("userId", "=", userId)
      .executeTakeFirst();
    return (row?.notifyEnabled ?? 1) === 1;
  }

  /**
   * Sets the per-user notification master switch (on = receive pushes). Upserts
   * so it works for a user whose `user_meta` row was never created (e.g. a
   * user minted before this column existed): `role` falls back to its DB
   * default and only the switch is written on conflict.
   */
  async setNotifyEnabled(userId: string, on: boolean): Promise<void> {
    await this.db
      .insertInto("userMeta")
      // role is only used if the row is being created (a brand-new user_meta);
      // an existing admin's role is preserved because the update sets only the
      // switch. "user" matches the column's DB default.
      .values({ userId, role: "user", notifyEnabled: on ? 1 : 0 })
      .onConflict((oc) => oc.column("userId").doUpdateSet({ notifyEnabled: on ? 1 : 0 }))
      .execute();
  }

  /**
   * The user's terminal attach history cap, or null when they have no
   * preference (the instance default applies). A missing row reads as "no
   * preference", exactly like a missing `notifyEnabled` row reads as "on".
   * @param userId - better-auth user id
   */
  async getTerminalReplayLines(userId: string): Promise<number | null> {
    const row = await this.db
      .selectFrom("userMeta")
      .select("terminalReplayLines")
      .where("userId", "=", userId)
      .executeTakeFirst();
    return row?.terminalReplayLines ?? null;
  }

  /**
   * Sets the per-user terminal history cap (`null` = back to the instance
   * default). Upserts for the same reason as {@link setNotifyEnabled}: a user
   * predating this column may have no row to update; `role` falls back to its
   * DB default and only the cap is written on conflict.
   */
  async setTerminalReplayLines(userId: string, lines: number | null): Promise<void> {
    await this.db
      .insertInto("userMeta")
      .values({ userId, role: "user", terminalReplayLines: lines })
      .onConflict((oc) => oc.column("userId").doUpdateSet({ terminalReplayLines: lines }))
      .execute();
  }

  /**
   * Writes the approval lifecycle state and its queue timestamp TOGETHER
   * (spec 2026-09-24 §6): entering `pending` stamps `pendingArrivedAt` (the
   * caller's own timestamp, or now), and leaving pending clears it to NULL —
   * so an approved or rejected row can never carry a stale arrival clock the
   * expiry sweep would one day act on. Upserts like the other setters: an
   * OIDC arrival's `user_meta` row is written by the promotion hook moments
   * EARLIER in the same request, but a hand-created user may have none.
   *
   * @param userId - better-auth user id
   * @param state - the lifecycle state to record
   * @param opts.arrivedAt - the stamp to write when entering pending
   *   (defaults to now); ignored when leaving it
   */
  async setApproval(userId: string, state: ApprovalState, opts?: { arrivedAt?: string | null }): Promise<void> {
    const pendingArrivedAt = state === "pending" ? (opts?.arrivedAt ?? new Date().toISOString()) : null;
    await this.db
      .insertInto("userMeta")
      .values({ userId, role: "user", approvalState: state, pendingArrivedAt })
      .onConflict((oc) => oc.column("userId").doUpdateSet({ approvalState: state, pendingArrivedAt }))
      .execute();
  }

  /**
   * Writes an approval decision ONLY when the row is not already APPROVED,
   * with the check and the write in ONE transaction (final review, minor —
   * the {@link setRole} / `patchGuardingLastProvider` precedent).
   *
   * The route used to ask {@link approvalState} and then {@link setApproval}
   * as two statements: two concurrent approves on one pending row could both
   * pass the already-approved gate and write the decision twice — two
   * `user.approve` audit rows for one human act. (Under today's dialect the
   * interleaving is hard to observe: `bun:sqlite` is synchronous over one
   * shared connection. The invariant lives in the SHAPE, not the timing —
   * which is exactly why the precedent folds it in the repository.)
   *
   * Absent row and out-of-enum values read APPROVED — the same
   * {@link approvalState} fail-open the route refused on — so this method's
   * `false` answer is exactly the 409 the wire contract (APPROVAL_NOOP) is.
   *
   * @returns `false` when the target is already approved (nothing written),
   *   `true` when the decision landed
   */
  async setApprovalUnlessApproved(
    userId: string,
    state: ApprovalState,
    opts?: { arrivedAt?: string | null },
  ): Promise<boolean> {
    return await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("userMeta")
        .select("approvalState")
        .where("userId", "=", userId)
        .executeTakeFirst();
      if (asApprovalState(row?.approvalState) === "approved") return false;
      await new UserMetaRepository(trx).setApproval(userId, state, opts);
      return true;
    });
  }

  /**
   * The user's approval state. An ABSENT `user_meta` row reads as APPROVED,
   * exactly like {@link isDisabled} reads an absent row as enabled — every
   * account predating the column must keep signing in on the upgrade that
   * added it. The narrowing goes through `asApprovalState`, so a hand-edited
   * value outside the enum reads approved too (fail-open by the same
   * argument: this column gates arrivals, not members).
   *
   * On the hot path with `accountPending`: `session.create.before` asks this
   * on every session mint.
   *
   * @param userId - better-auth user id
   */
  async approvalState(userId: string): Promise<ApprovalState> {
    const row = await this.db
      .selectFrom("userMeta")
      .select("approvalState")
      .where("userId", "=", userId)
      .executeTakeFirst();
    return asApprovalState(row?.approvalState);
  }

  /**
   * Undoes the first-admin promotion for an account that `user.create.after`
   * JUST auto-promoted and `account.create.after` is now marking pending
   * (spec 2026-09-24 §6). The `WHERE role = 'admin'` clause is the whole
   * guard: the caller runs this only for a genuine ARRIVAL (a fresh user with
   * exactly one account — the same hook skips links, which is where an
   * existing admin's row could otherwise be reached), immediately after the
   * promotion statement wrote that admin row for the same user, so the only
   * row it can touch is the one the promotion path just wrote.
   *
   * **The last-admin guard of {@link setRole} is deliberately bypassed**, and
   * that is sound rather than sloppy: the guard exists so an instance never
   * LOSES an administrator someone relied on. Here the "admin" is seconds
   * old, was never observable by anyone (the account is being created right
   * now), and its arrival through a require-approval provider means the instance
   * was admin-less a moment before this request. Refusing the demote would
   * leave an unapproved OIDC arrival as the operator of the whole control
   * plane — the exact inversion §6 exists to prevent. `setup_step` clears in
   * the same statement for the same reason: the wizard bookmark belongs to
   * whoever is actually admin, and a pending arrival must not own the
   * first-run handoff.
   */
  async demoteAdminIfAutoPromoted(userId: string): Promise<void> {
    await this.db
      .updateTable("userMeta")
      .set({ role: "user", setupStep: null })
      .where("userId", "=", userId)
      .where("role", "=", "admin")
      .execute();
  }

  /**
   * Re-stamps the §6 arrival clock for the pending row owning `email`, and
   * ONLY a pending row (spec 2026-09-24 §6 dedup: a repeat knock on a still
   * unapproved provider refreshes its position in the expiry queue; an approved,
   * rejected or absent row is never touched). Raw SQL because it spans
   * better-auth's `user` table and the app's `user_meta` in one statement —
   * physical snake_case names per the plugin-bypass rule; `email` arrives
   * already lowercased from the caller's normalization.
   */
  async touchPendingArrivedByEmail(email: string, arrivedAt: string = new Date().toISOString()): Promise<void> {
    await sql`
      UPDATE user_meta SET pending_arrived_at = ${arrivedAt}
      WHERE approval_state = 'pending'
        AND user_id = (SELECT id FROM user WHERE lower(email) = ${email})
    `.execute(this.db);
  }
}
