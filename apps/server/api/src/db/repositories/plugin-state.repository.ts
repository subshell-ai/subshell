import { BaseRepository } from "@/db/repositories/base.repository.js";

/**
 * The instance-level `enabled` flag for installed plugins (spec 2026-09-10
 * §6.1) — the only per-plugin state the instance keeps in the database.
 *
 * **An absent row means enabled.** Installing writes nothing; only an
 * explicit toggle creates a row, and `setEnabled` writes it BOTH ways (an
 * enabled row after a disable/re-enable cycle is the operator's recorded
 * choice, not noise — the absent-row default belongs to pre-flag installs).
 */
export class PluginStateRepository extends BaseRepository {
  /** True unless a row explicitly disables the plugin. Absent row = enabled. */
  async isEnabled(pluginId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("pluginState")
      .select("enabled")
      .where("pluginId", "=", pluginId)
      .executeTakeFirst();
    return row?.enabled !== 0;
  }

  /**
   * Every stored row as `pluginId → enabled`, for filtering the installed set
   * in one read (the batch consumers — gate, view, list — all filter rather
   * than ask plugin-by-plugin).
   */
  async stateByPluginId(): Promise<Map<string, boolean>> {
    const rows = await this.db.selectFrom("pluginState").select(["pluginId", "enabled"]).execute();
    return new Map(rows.map((r) => [r.pluginId, r.enabled !== 0]));
  }

  /** Writes the flag (upsert). The row is written for BOTH directions. */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("pluginState")
      .values({ pluginId, enabled: enabled ? 1 : 0, updatedAt: now })
      .onConflict((oc) => oc.column("pluginId").doUpdateSet({ enabled: enabled ? 1 : 0, updatedAt: now }))
      .execute();
  }

  /**
   * Drops the row on uninstall. The state describes an INSTALLED plugin —
   * keeping a disabled row across an uninstall would make a later reinstall
   * come back disabled, contradicting "installing writes nothing, and the
   * default is on".
   */
  async clear(pluginId: string): Promise<void> {
    await this.db.deleteFrom("pluginState").where("pluginId", "=", pluginId).execute();
  }
}
