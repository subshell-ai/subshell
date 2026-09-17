import { BaseRepository } from "@/db/repositories/base.repository.js";

/**
 * The mirror behind {@link isPluginEnabledSync}: what the last in-process
 * read or write of `plugin_state` said, per plugin. An absent entry is the
 * absent-row default — enabled.
 *
 * This is a faithful mirror because this class is the table's ONLY writer in
 * this process: the CLI never opens it, and nothing else holds a handle that
 * could. `stateByPluginId` MERGES rather than rebuilds — a rebuild would let
 * a read that started before a `setEnabled` landed wipe that write's cache
 * flip with the pre-flip DB state, which is exactly the window the sync view
 * exists to close.
 */
const enabledCache = new Map<string, boolean>();

/**
 * Whether a plugin is enabled, answered SYNCHRONOUSLY from {@link
 * enabledCache} — never by awaiting the database.
 *
 * It exists for one caller and one reason (`services/network/origins.ts`):
 * a status observation that captured its plugin list while the plugin was
 * enabled must not re-trust its addresses into the registry after a disable
 * has forgotten them, and the only check that can carry that promise is one
 * with no await between reading it and writing. `setEnabled`/`clear` flip
 * this view synchronously, before their SQL lands, so the caller that sees
 * `true` is guaranteed the disable's forget has not run yet.
 *
 * Fails open on an unhydrated entry (`?? true`): the honest default is the
 * database's own absent-row default, and safety does not rest on this read
 * being warm — the guarded writer runs on every observation regardless.
 */
export function isPluginEnabledSync(pluginId: string): boolean {
  return enabledCache.get(pluginId) ?? true;
}

/**
 * The instance-level `enabled` flag for installed plugins (spec 2026-09-10
 * §6.1) — the only per-plugin state the instance keeps in the database.
 *
 * **An absent row means enabled.** Installing writes nothing; only an
 * explicit toggle creates a row, and `setEnabled` writes it BOTH ways (an
 * enabled row after a disable/re-enable cycle is the operator's recorded
 * choice, not noise — the absent-row default belongs to pre-flag installs).
 *
 * Every method keeps {@link enabledCache} current, because the cache is only
 * a mirror if there is exactly one thing being mirrored: writes go through
 * this class, and this class is the table's only writer (see
 * {@link enabledCache}).
 */
export class PluginStateRepository extends BaseRepository {
  /** True unless a row explicitly disables the plugin. Absent row = enabled. */
  async isEnabled(pluginId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("pluginState")
      .select("enabled")
      .where("pluginId", "=", pluginId)
      .executeTakeFirst();
    const enabled = row?.enabled !== 0;
    enabledCache.set(pluginId, enabled);
    return enabled;
  }

  /**
   * Every stored row as `pluginId → enabled`, for filtering the installed set
   * in one read (the batch consumers — gate, view, list — all filter rather
   * than ask plugin-by-plugin).
   */
  async stateByPluginId(): Promise<Map<string, boolean>> {
    const rows = await this.db.selectFrom("pluginState").select(["pluginId", "enabled"]).execute();
    const state = new Map(rows.map((r) => [r.pluginId, r.enabled !== 0]));
    // MERGE into the sync view, never replace it — see `enabledCache`.
    for (const [pluginId, enabled] of state) enabledCache.set(pluginId, enabled);
    return state;
  }

  /**
   * Writes the flag (upsert). The row is written for BOTH directions.
   *
   * The sync view flips BEFORE the await — that ordering is the contract
   * {@link isPluginEnabledSync} exists on: a caller that observes `true`
   * during a disable is guaranteed the flip (and everything the disable route
   * orders after it, the registry forget included) has not happened yet.
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    enabledCache.set(pluginId, enabled);
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
    enabledCache.delete(pluginId);
    await this.db.deleteFrom("pluginState").where("pluginId", "=", pluginId).execute();
  }
}
