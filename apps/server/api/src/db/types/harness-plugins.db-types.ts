/**
 * Database table schema for harness plugins.
 *
 * Rows are created lazily when a plugin is first enabled/disabled;
 * the built-in registry is the source of truth for what exists.
 */
export interface HarnessPluginTable {
  /** Plugin id, e.g. "claude-code" */
  id: string;
  /** 1 = enabled, 0 = disabled (hidden from setup + subshell creation) */
  enabled: number;
  /** ISO 8601 timestamp when the row was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

export type NewHarnessPlugin = Pick<HarnessPluginTable, "id"> & Partial<Omit<HarnessPluginTable, "id">>;
