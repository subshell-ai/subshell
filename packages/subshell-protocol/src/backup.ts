/** Declarative form contract shared by the server, CLI and bundled recovery UI. */
export type RestoreMode = "same-machine" | "migration";

export interface RestoreAddressOverrides {
  baseUrl?: string;
  host?: string;
  port?: string | number;
  trustedOrigins?: string;
}

export interface BackupRestoreChoices {
  mode: RestoreMode;
  configOverrides?: RestoreAddressOverrides;
}

export const BACKUP_RESTORE_DEFAULTS = {
  mode: "same-machine" as RestoreMode,
  recoverAdmin: false,
  start: true,
  encrypt: false,
} as const;

export const BACKUP_RESTORE_MODES = [
  { value: "same-machine", label: "Same-machine recovery" },
  { value: "migration", label: "Move to a new machine" },
] as const;
