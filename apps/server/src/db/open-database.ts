import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";

/**
 * Opens a bun:sqlite database at the given path (`:memory:` for a temp DB).
 * Ensures the parent dir exists, enables foreign keys, and uses WAL for
 * file-backed DBs (better concurrency for the single-connection runtime).
 *
 * Every database handle in this app is opened through here, which is what
 * makes `PRAGMA foreign_keys = ON` a guarantee rather than a hope — the
 * `workspace_panes` cascades depend on it, and SQLite silently ignores
 * foreign keys when the pragma is off.
 *
 * The database file is created with the process's default umask, so callers
 * that open a persistent DB should also ensure the containing directory has
 * tight permissions (see `ensureTightFilePerms`).
 *
 * @param path - The database path, or `:memory:` / a `mode=memory` URI
 * @returns An open bun:sqlite database with the pragmas already applied
 */
export function openSqliteDatabase(path: string): Database {
  const inMemory = isInMemoryPath(path);
  if (!inMemory) {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  // WAL is meaningless for an in-memory database (SQLite silently reports
  // "memory" instead), and there is no file whose directory needs creating.
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/**
 * True when `path` names an in-memory database rather than a file.
 *
 * Covers both `:memory:` and SQLite's URI form, e.g.
 * `file::memory:?cache=shared`. In real SQLite the URI form matters because
 * plain `:memory:` gives every connection its own private database — two
 * connections cannot see each other's tables — whereas a shared-cache URI
 * lets several connections share one in-memory database.
 *
 * Bun's `new Database(...)` does NOT interpret URIs, though: it treats the
 * string as a plain file name, so passing one here would silently create a
 * file literally named `file::memory:?cache=shared` in the CWD. That is why
 * the test suite points at a per-process temp file instead (see
 * `constants.ts`). The URI pattern stays as a safety net for callers that
 * genuinely pass `:memory:` (several suites open private scratch DBs that
 * way); recognising them skips the WAL pragma and parent-dir creation,
 * neither of which means anything without a file.
 *
 * @param path - The database path or SQLite URI
 */
function isInMemoryPath(path: string): boolean {
  return path === ":memory:" || /(^|[?&])mode=memory|:memory:/.test(path);
}
