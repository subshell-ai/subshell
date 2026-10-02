/** Explicit host paths; restore destinations are independently validated operator choices. */
export interface InstancePaths {
  /** SQLite database file, possibly outside dataDir. */
  databasePath: string;
  /** Server-owned state directory. */
  dataDir: string;
  /** Supported config.env destination/source. */
  configPath?: string;
}

/** Resource ceilings applied before archive parsing and file writes. */
export interface BackupLimits {
  /** Maximum stored archive bytes. */
  archiveBytes: number;
  /** Maximum decompressed tar bytes (including tar overhead). */
  expandedBytes: number;
  /** Maximum size of any component file. */
  fileBytes: number;
  /** Maximum number of regular files. */
  files: number;
}

/** One logical, checksummed payload file. */
export interface BackupEntry {
  /** Relative logical path, never a host path. */
  path: string;
  /** Captured bytes; growing logs stop at their captured length. */
  bytes: number;
  /** Lowercase hexadecimal SHA-256. */
  sha256: string;
}

/** Public archive metadata; credentials live only in payload files. */
export interface InstanceBackupManifest {
  /** Original locations for form prefilling only, never an automatic restore destination. Older archives omit these. */
  sourcePaths?: InstancePaths;
  /** Archive contract identifier. */
  format: "subshell-instance";
  /** Format version, independent of server version. */
  version: 1;
  /** Server release that wrote this archive. */
  serverVersion: string;
  /** First capture instant, ISO 8601. */
  startedAt: string;
  /** Last capture instant, ISO 8601. */
  completedAt: string;
  /** SQLite's recorded application migrations. */
  migrations: string[];
  /** Logs are captured over this interval, rather than atomically with SQLite. */
  consistency: "sqlite-snapshot-logs-over-interval" | "legacy-database-only";
  /** Every regular payload file, with lengths and hashes. */
  entries: BackupEntry[];
  /** Exclusions recorded so an operator understands the archive's boundary. */
  exclusions: string[];
}

/** Administrator identifiers shown during inspection, without password or auth data. */
export interface BackupAdmin {
  /** User identifier. */
  id: string;
  /** Sign-in email. */
  email: string;
  /** Display name. */
  name: string;
}

/** Validated inspection result. */
export interface BackupInspection {
  /** Validated manifest. */
  manifest: InstanceBackupManifest;
  /** Existing administrators from the snapshot. */
  admins: BackupAdmin[];
  /** Explicitly identifies an old .db snapshot, which contains no instance state. */
  legacyDatabaseOnly: boolean;
}

/** Private extracted state; callers may apply administrator recovery before replacement. */
export interface StagedInstanceBackup extends BackupInspection {
  /** Owned 0700 staging directory. */
  dir: string;
  /** Standalone SQLite snapshot accessible for recovery changes. */
  databasePath: string;
  /** Deletes the owned staging directory. */
  cleanup(): Promise<void>;
}

/** Inputs for online snapshot creation. */
export interface CreateInstanceBackupOptions {
  /** Explicit paths of this server's instance. */
  source: InstancePaths;
  /** New output archive path; existing files are refused. */
  destinationPath: string;
  /** Effective supported runtime values, overriding the config file layer. */
  effectiveConfig?: Record<string, string>;
  /** Optional password; empty passwords are refused. */
  password?: string;
  /** Optional stricter resource ceilings. */
  limits?: Partial<BackupLimits>;
}

/** Restore-time address choices, validated by configure's shared predicates. */
export interface RestoreConfigOverrides {
  /** New public base URL. */
  baseUrl?: string;
  /** New listening host. */
  host?: string;
  /** New listening port. */
  port?: number | string;
  /** Comma-separated exact origins. */
  trustedOrigins?: string;
}

/** Offline replacement policy; stopping services belongs to the caller. */
export interface RestoreInstanceBackupOptions {
  /** Explicit destination paths. */
  destination: InstancePaths;
  /** Migration clears publication and disables network plugins pending review. */
  mode?: "same-machine" | "migration";
  /** Address choices shared by CLI, API, and desktop callers. */
  configOverrides?: RestoreConfigOverrides;
  /** Durable journal: restore-journal.json beside config, or in dataDir for legacy without a config path. */
  journalPath?: string;
  /** Reserved prepared-stage UUID; omitted for direct archive application. Never reuse a consumed ID. */
  transactionId?: string;
  /** Failure-injection/diagnostic seam, called after each component replacement. */
  afterReplace?: (component: string) => void | Promise<void>;
}
