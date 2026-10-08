import { buildSshConfigPath } from "@internal/pane-runtime";
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

/**
 * The rendered ssh config for one pane ON THE SERVER's own disk — the local
 * twin of the node-side path the agent derives from its own dataDir
 * (spec 2026-10-07 decision 4). The composition is the pane-runtime
 * {@link buildSshConfigPath} itself, not a re-spelling of its template:
 * plane and node agree byte-for-byte because they call ONE function, and the
 * `LocalLauncher` launch path refuses a plan whose `configPath` disagrees
 * with this derivation. Throws on an id outside the composition guard, like
 * every other call site.
 */
export function subshellSshConfigPath(id: string): string {
  return buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id);
}
