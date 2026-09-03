import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SettingTable } from "@/db/types/settings.db-types.js";

/**
 * Repository for key/value app settings. Values are JSON-encoded strings.
 */
export class SettingsRepository extends BaseRepository {
  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db.selectFrom("settings").select("value").where("key", "=", key).executeTakeFirst();
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("settings")
      .values({ key, value: JSON.stringify(value), updatedAt: now })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          value: JSON.stringify(value),
          updatedAt: now,
        }),
      )
      .execute();
  }

  async all(): Promise<SettingTable[]> {
    return this.db.selectFrom("settings").selectAll().execute();
  }

  async delete(key: string): Promise<void> {
    await this.db.deleteFrom("settings").where("key", "=", key).execute();
  }
}
