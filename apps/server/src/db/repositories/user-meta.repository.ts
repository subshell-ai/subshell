import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewUserMeta } from "@/db/types/user-meta.db-types.js";

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

  async countUsers(): Promise<number> {
    const row = await this.db
      .selectFrom("userMeta")
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
