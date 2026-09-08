/**
 * Database table schema for key/value app settings.
 */
export interface SettingTable {
  /** Setting key, e.g. "allow_registrations" */
  key: string;
  /** JSON-encoded value */
  value: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

export type NewSetting = Omit<SettingTable, "updatedAt">;
