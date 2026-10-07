import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SshSavedLocationTable } from "@/db/types/ssh-saved-locations.db-types.js";

export class SshSavedLocationsRepository extends BaseRepository {
  list(ownerUserId: string) {
    return this.db
      .selectFrom("sshSavedLocations")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .orderBy("createdAt", "desc")
      .execute();
  }
  find(id: string, ownerUserId: string) {
    return this.db
      .selectFrom("sshSavedLocations")
      .selectAll()
      .where("id", "=", id)
      .where("ownerUserId", "=", ownerUserId)
      .executeTakeFirst();
  }
  create(row: SshSavedLocationTable) {
    return this.db.insertInto("sshSavedLocations").values(row).returningAll().executeTakeFirstOrThrow();
  }
  async delete(id: string, ownerUserId: string) {
    return this.db
      .deleteFrom("sshSavedLocations")
      .where("id", "=", id)
      .where("ownerUserId", "=", ownerUserId)
      .executeTakeFirst();
  }
}
