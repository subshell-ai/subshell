import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewProfile, ProfileTable, ProfileUpdate } from "@/db/types/profiles.db-types.js";

/**
 * Repository for harness profiles.
 */
export class ProfilesRepository extends BaseRepository {
  async create(profile: NewProfile): Promise<ProfileTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("profiles")
      .values({
        ...profile,
        // restartOnExit (0003) and isDefault (0010) default in the DB; mirror
        // them here so the row is complete on read-back.
        restartOnExit: profile.restartOnExit ?? 0,
        isDefault: profile.isDefault ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<ProfileTable | undefined> {
    return this.db.selectFrom("profiles").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async listByUser(userId: string, harnessId?: string): Promise<ProfileTable[]> {
    let query = this.db.selectFrom("profiles").selectAll().where("userId", "=", userId).orderBy("name", "asc");
    if (harnessId) query = query.where("harnessId", "=", harnessId);
    return query.execute();
  }

  /**
   * Inserts `profile` ONLY while its (userId, harnessId) pair has no profile
   * at all — one `INSERT … SELECT … WHERE NOT EXISTS` statement, so two
   * overlapping seed calls (registration racing a harness enable) can never
   * both land a row. That matters here because a seeded row is unremovable:
   * a duplicate Default would be permanently undeletable. Column defaults do
   * the rest of the work. @returns true when a row was actually inserted.
   */
  async insertIfNoneForPair(profile: NewProfile): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await sql`
      insert into profiles (
        id, user_id, harness_id, name, description, env_json, flags_json,
        settings_json, config_isolation, restart_on_exit, is_default, created_at, updated_at
      )
      select
        ${profile.id}, ${profile.userId}, ${profile.harnessId}, ${profile.name},
        ${profile.description ?? null}, ${profile.envJson ?? null}, ${profile.flagsJson ?? null},
        ${profile.settingsJson ?? null}, ${profile.configIsolation}, ${profile.restartOnExit ?? 0},
        ${profile.isDefault ?? 0}, ${now}, ${now}
      where not exists (
        select 1 from profiles where user_id = ${profile.userId} and harness_id = ${profile.harnessId}
      )
    `.execute(this.db);
    // kysely-bun-sqlite-dialect reports `numAffectedRows` (Kysely's generic
    // QueryResult fields are all undefined here) — that count is the whole
    // point: 1 means the NOT EXISTS held and the row landed.
    const affected = (res as unknown as { numAffectedRows?: number | bigint }).numAffectedRows ?? 0;
    return Number(affected) > 0;
  }

  async update(id: string, update: ProfileUpdate): Promise<ProfileTable | undefined> {
    await this.db
      .updateTable("profiles")
      .set({ ...update, updatedAt: sql`(datetime('now'))` })
      .where("id", "=", id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("profiles").where("id", "=", id).execute();
  }
}
