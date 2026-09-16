import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
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
}
