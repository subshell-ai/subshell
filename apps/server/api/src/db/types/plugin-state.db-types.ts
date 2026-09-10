/**
 * The instance-level state of one installed plugin (spec 2026-09-10 §6.1).
 *
 * One row per plugin an operator has EXPLICITLY toggled. The absence of a
 * row is the default — enabled — which is what lets installing write nothing
 * and what keeps a pre-Task-9 install (installed before the table existed)
 * from needing a backfill. Never store the flag in `install.json`: the
 * installer rewrites that sidecar on every install.
 */
export interface PluginStateTable {
  /** Plugin id (matches `<dataDir>/plugins/<id>/`); also the PK */
  pluginId: string;
  /** 1 = offered, 0 = disabled (bytes and profiles kept). An absent row means 1 */
  enabled: number;
  /** ISO 8601 when the flag was last written */
  updatedAt: string;
}
