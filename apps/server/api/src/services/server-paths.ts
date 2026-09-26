import { DATABASE_PATH, NODE_ARTIFACTS_DIR, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { backupsDir } from "@/services/db-backup.js";
import { subshellLogDir } from "@/services/nodes/subshell-paths.js";
import { serverLogPath } from "@/utils/log-file.js";

/**
 * Where this instance's data lives, as ONE pure assembly of the resolved
 * constants.
 *
 * This is deliberately a shared function rather than two call sites reading
 * the same constants: `status` publishes this block as the authority a
 * consumer deletes against, and `subshell-server reset`/`uninstall` delete
 * EXACTLY it. The desktop assistant re-reads it through `status --json`; a
 * second private spelling of the same five paths is how a reset could one day
 * promise bytes gone that a later refactor left behind.
 */
export interface ServerPaths {
  /** The instance's data home: SQLite, logs, artifacts and backups nest in it by default. */
  dataDir: string;
  /** The SQLite file. */
  database: string;
  /** Where subshell (pane) logs are written on this host. */
  logsDir: string;
  /** Where node release artifacts this plane fetched live. */
  nodeArtifacts: string;
  /** The server's own 200 KB log file (inside `dataDir` by the default layout). */
  serverLog: string;
  /** Where `backup` writes its database snapshots (inside `dataDir` deliberately). */
  backups: string;
}

/** The five-path data block, resolved fresh from the ambient constants. */
export function serverPaths(): ServerPaths {
  return {
    dataDir: SUBSHELL_SERVER_DATA_DIR,
    database: DATABASE_PATH,
    logsDir: subshellLogDir(),
    nodeArtifacts: NODE_ARTIFACTS_DIR,
    serverLog: serverLogPath(),
    backups: backupsDir(),
  };
}
