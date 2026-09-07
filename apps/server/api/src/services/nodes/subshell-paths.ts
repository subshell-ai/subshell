import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";

/**
 * The directory holding every per-subshell output log. Split out from
 * {@link subshellLogPath} so the launcher can ensure it exists without
 * inventing a fake id.
 */
export function subshellLogDir(): string {
  return `${SUBSHELL_SERVER_DATA_DIR}/subshells`;
}

/**
 * Per-subshell output log file under the app data dir.
 *
 * Reads {@link SUBSHELL_SERVER_DATA_DIR}, which defaults to the database file's own
 * directory. It used to re-derive that from `process.env.DATABASE_PATH` here,
 * which broke for a database path with no dirname to take (an in-memory
 * database or a SQLite URI) and silently wrote into the process's cwd.
 */
export function subshellLogPath(id: string): string {
  return `${subshellLogDir()}/${id}.log`;
}
