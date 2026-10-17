import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SshPresetTable } from "@/db/types/ssh-presets.db-types.js";

/**
 * Saved SSH connection presets. This repository holds database calls only: it
 * offers owned and accessible lists, but `findById`/`update`/`delete` ask by id
 * alone. Handlers enforce viewer access and render an inaccessible row as
 * the same 404 an absent one gets (the ownership axis, docs/security.md §3).
 * `update` takes the WHOLE row as the service composes it, partial only so
 * the caller can omit what it is not deciding about.
 */
export class SshPresetsRepository extends BaseRepository {
  async listByUser(userId: string) {
    return this.db.selectFrom("sshPresets").selectAll().where("userId", "=", userId).orderBy("name").execute();
  }
  /** Cookie readers can see owned presets and matching named/Everyone grants. */
  async listAccessible(userId: string) {
    return this.db
      .selectFrom("sshPresets")
      .selectAll("sshPresets")
      .where((eb) =>
        eb.or([
          eb("userId", "=", userId),
          eb.exists(
            eb
              .selectFrom("sshPresetShares")
              .select("id")
              .whereRef("presetId", "=", "sshPresets.id")
              .where((share) => share.or([share("granteeUserId", "is", null), share("granteeUserId", "=", userId)])),
          ),
        ]),
      )
      .orderBy("name")
      .execute();
  }

  async findById(id: string) {
    return this.db.selectFrom("sshPresets").selectAll().where("id", "=", id).executeTakeFirst();
  }
  async create(row: SshPresetTable) {
    return this.db.insertInto("sshPresets").values(row).returningAll().executeTakeFirstOrThrow();
  }
  async update(id: string, row: Partial<SshPresetTable>) {
    return this.db.updateTable("sshPresets").set(row).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
  }
  async delete(id: string) {
    await this.db.deleteFrom("sshPresets").where("id", "=", id).execute();
  }
}
