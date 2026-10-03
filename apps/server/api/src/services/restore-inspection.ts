import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "@/config-env.js";
import { DEFAULT_TRUSTED_ORIGINS } from "@/constants.js";
import type { InstancePaths, StagedInstanceBackup } from "./backups/types.js";

/** Prefill from the archive, falling back locally only for locations older backups omitted. */
export function restoreInspectionDefaults(
  stage: Pick<StagedInstanceBackup, "dir" | "manifest" | "legacyDatabaseOnly">,
  source: InstancePaths,
) {
  const config = stage.legacyDatabaseOnly
    ? {}
    : parseEnvFile(readFileSync(join(stage.dir, "config", "config.env"), "utf8"));
  const original = stage.manifest.sourcePaths;
  const port = config.SERVER_PORT ?? "3080";
  return {
    destination: {
      databasePath: original?.databasePath ?? config.DATABASE_PATH ?? source.databasePath,
      dataDir: original?.dataDir ?? config.SUBSHELL_SERVER_DATA_DIR ?? source.dataDir,
      configPath: original?.configPath ?? source.configPath ?? join(source.dataDir, "config.env"),
    },
    choices: {
      mode: "same-machine" as const,
      configOverrides: stage.legacyDatabaseOnly
        ? {}
        : {
            host: config.HOST ?? "0.0.0.0",
            port,
            baseUrl: config.APP_BASE_URL ?? `http://localhost:${port}`,
            trustedOrigins: config.TRUSTED_ORIGINS ?? DEFAULT_TRUSTED_ORIGINS,
          },
    },
  };
}
