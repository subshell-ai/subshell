import { type ConfigKey, normalizeTrustedOrigins, validateValue } from "../../commands/config-values.js";
import { parseEnvFile } from "../../config-env.js";
import type { InstancePaths, RestoreConfigOverrides } from "./types.js";

/** Supported effective values. Emergency recovery passwords and arbitrary host environment are excluded. */
export const BACKUP_CONFIG_KEYS = [
  "BETTER_AUTH_SECRET",
  "SERVER_PORT",
  "HOST",
  "APP_BASE_URL",
  "TRUSTED_ORIGINS",
  "DATABASE_PATH",
  "SUBSHELL_SERVER_DATA_DIR",
  "SUBSHELL_LOG_RETENTION_DAYS",
  "SUBSHELL_DB_BACKUPS_KEEP",
  "SUBSHELL_RELEASE_URL",
  "SUBSHELL_PLUGIN_REGISTRY_URL",
  "NODE_ENV",
  "SUBSHELL_FS_ROOT",
  "SUBSHELL_DEBUG_LOGGING",
  "SUBSHELL_TERMINAL_REPLAY_LINES",
] as const;

/** Filter config layers and refuse values that cannot safely be serialized. */
export function captureConfig(stored: string, effective: Record<string, string> = {}): Record<string, string> {
  if (Buffer.byteLength(stored) > 1024 * 1024) throw new Error("backup configuration exceeds limit");
  const merged = { ...parseEnvFile(stored), ...effective };
  const config: Record<string, string> = {};
  for (const key of BACKUP_CONFIG_KEYS) {
    const value = merged[key];
    if (value === undefined) continue;
    if (/[\r\n]/.test(value) || value.includes("\0") || value !== value.trim() || /^['"]|['"]$/.test(value)) {
      throw new Error(`backup cannot safely serialize configuration key ${key}`);
    }
    config[key] = value;
  }
  if (Buffer.byteLength(serializeConfig(config)) > 1024 * 1024) throw new Error("backup configuration exceeds limit");
  if (!config.BETTER_AUTH_SECRET || config.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("backup requires the effective authentication secret (at least 32 characters)");
  }
  return config;
}

/** Render filtered effective config with local paths and validated address overrides. */
export function restoreConfig(
  text: string,
  destination: InstancePaths,
  overrides: RestoreConfigOverrides = {},
): string {
  validateRestoreConfigOverrides(overrides);
  const config = captureConfig(text);
  config.DATABASE_PATH = destination.databasePath;
  config.SUBSHELL_SERVER_DATA_DIR = destination.dataDir;
  const choices: Partial<Record<ConfigKey, string>> = {
    APP_BASE_URL: overrides.baseUrl,
    HOST: overrides.host,
    SERVER_PORT: overrides.port === undefined ? undefined : String(overrides.port),
    TRUSTED_ORIGINS: overrides.trustedOrigins,
  };
  for (const [key, value] of Object.entries(choices)) {
    if (value === undefined) continue;
    const problem = validateValue(key as ConfigKey, value);
    if (problem) throw new Error(problem);
    if (key === "TRUSTED_ORIGINS") {
      const normalized = normalizeTrustedOrigins(value);
      if (normalized) config[key] = normalized;
      else delete config[key];
    } else {
      config[key] = value;
    }
  }
  for (const key of ["DATABASE_PATH", "SUBSHELL_SERVER_DATA_DIR"]) {
    if (/[\r\n]/.test(config[key] ?? "") || config[key]?.includes("\0"))
      throw new Error("invalid restore destination path");
  }
  return serializeConfig(captureConfig("", config));
}

/** Validate restore form values through the same predicates used by configure. */
export function validateRestoreConfigOverrides(overrides: RestoreConfigOverrides): void {
  const choices: Partial<Record<ConfigKey, string>> = {
    APP_BASE_URL: overrides.baseUrl,
    HOST: overrides.host,
    SERVER_PORT: overrides.port === undefined ? undefined : String(overrides.port),
    TRUSTED_ORIGINS: overrides.trustedOrigins,
  };
  for (const [key, value] of Object.entries(choices)) {
    if (value === undefined) continue;
    const problem = validateValue(key as ConfigKey, value);
    if (problem) throw new Error(problem);
  }
}

/** Deterministic config.env encoding of already validated values. */
export function serializeConfig(config: Record<string, string>): string {
  return `${Object.entries(config)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}
