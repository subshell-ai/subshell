import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";

/**
 * Repository for harness plugin enabled/disabled state.
 * Rows are created lazily; absence of a row means "enabled by default".
 */
export class HarnessPluginsRepository extends BaseRepository {
  /**
   * The lazily-written rows for the given plugin ids. A plugin with NO row is
   * absent from the map — the caller applies that plugin's own
   * `enabledByDefault` (`states.get(id) ?? h.enabledByDefault`), which is the
   * one enable rule shared by the picker filter, the setup list, and the
   * default-profile seeder. Pre-filling a hard `true` here would silently
   * outvote any future plugin that ships disabled by default.
   */
  async getEnabledStates(pluginIds: string[]): Promise<Map<string, boolean>> {
    if (pluginIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("harnessPlugins")
      .select(["id", "enabled"])
      .where("id", "in", pluginIds)
      .execute();
    const map = new Map<string, boolean>();
    for (const row of rows) map.set(row.id, row.enabled === 1);
    return map;
  }

  /** Sets the enabled state for a plugin, upserting the row. */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("harnessPlugins")
      .values({
        id: pluginId,
        enabled: enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          enabled: enabled ? 1 : 0,
          updatedAt: sql`excluded.updated_at`,
        }),
      )
      .execute();
  }
}
