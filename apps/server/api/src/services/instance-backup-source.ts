import { join, resolve } from "node:path";
import { configEnvPath, resolveConfig } from "@/config-env.js";
import {
  APP_BASE_URL,
  AUTH_SECRET,
  DATABASE_PATH,
  HOST,
  IS_TEST,
  SERVER_PORT,
  SUBSHELL_SERVER_DATA_DIR,
} from "@/constants.js";

export function instanceBackupPaths() {
  return {
    databasePath: resolve(DATABASE_PATH),
    dataDir: resolve(SUBSHELL_SERVER_DATA_DIR),
    configPath: resolve(IS_TEST ? join(SUBSHELL_SERVER_DATA_DIR, "config.env") : configEnvPath()),
  };
}

/** Supported settings only; never capture an unrelated process environment. */
export function instanceBackupConfig(): Record<string, string> {
  const cfg = IS_TEST ? { values: {}, get: (_key: string): string | undefined => undefined } : resolveConfig();
  const result: Record<string, string> = {
    ...cfg.values,
    BETTER_AUTH_SECRET: AUTH_SECRET,
    APP_BASE_URL,
    HOST,
    SERVER_PORT: String(SERVER_PORT),
  };
  const keys = [
    "TRUSTED_ORIGINS",
    "SUBSHELL_LOG_RETENTION_DAYS",
    "SUBSHELL_TERMINAL_REPLAY_LINES",
    "SUBSHELL_FS_ROOT",
    "SUBSHELL_RELEASE_URL",
    "SUBSHELL_PLUGIN_REGISTRY_URL",
    "SUBSHELL_DEBUG_LOGGING",
    "NODE_ENV",
    "SUBSHELL_DB_BACKUPS_KEEP",
  ];
  for (const key of keys) {
    const value = cfg.get(key);
    if (value !== undefined) result[key] = value;
  }
  delete result.SUBSHELL_EMERGENCY_PASSWORD;
  return result;
}
