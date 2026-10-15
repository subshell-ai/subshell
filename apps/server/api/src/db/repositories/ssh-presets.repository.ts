import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SshPresetTable } from "@/db/types/ssh-presets.db-types.js";

export class SshPresetsRepository extends BaseRepository {
  async listByUser(userId: string) {
    return this.db.selectFrom("sshPresets").selectAll().where("userId", "=", userId).orderBy("name").execute();
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
