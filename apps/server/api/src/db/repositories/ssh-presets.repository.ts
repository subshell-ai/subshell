import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SshPresetTable } from "@/db/types/ssh-presets.db-types.js";

/**
 * Saved SSH connection presets. This repository holds database calls only: it
 * scopes LIST by owner, but `findById`/`update`/`delete` ask by id alone, and
 * the handler compares `userId` after the read and renders a foreign row as
 * the same 404 an absent one gets (the ownership axis, docs/security.md §3).
 * `update` takes the WHOLE row as the service composes it, partial only so
 * the caller can omit what it is not deciding about.
 */
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
