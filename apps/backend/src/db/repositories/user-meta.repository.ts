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
   * Whether this user receives session notifications (the master switch). A
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

  /** Sets the per-user notification master switch (on = receive pushes). */
  async setNotifyEnabled(userId: string, on: boolean): Promise<void> {
    await this.db
      .updateTable("userMeta")
      .set({ notifyEnabled: on ? 1 : 0 })
      .where("userId", "=", userId)
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
