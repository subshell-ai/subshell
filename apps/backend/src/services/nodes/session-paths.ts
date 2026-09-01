import { SESSION_DATA_DIR } from "@/constants.js";

/**
 * The directory holding every per-session output log. Split out from
 * {@link sessionLogPath} so the launcher can ensure it exists without
 * inventing a fake id.
 */
export function sessionLogDir(): string {
  return `${SESSION_DATA_DIR}/sessions`;
}

/**
 * Per-session output log file under the app data dir.
 *
 * Reads {@link SESSION_DATA_DIR}, which defaults to the database file's own
 * directory. It used to re-derive that from `process.env.DATABASE_PATH` here,
 * which broke for a database path with no dirname to take (an in-memory
 * database or a SQLite URI) and silently wrote into the process's cwd.
 */
export function sessionLogPath(id: string): string {
  return `${sessionLogDir()}/${id}.log`;
}
