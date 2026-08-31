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

  async countUsers(): Promise<number> {
    const row = await this.db
      .selectFrom("userMeta")
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
