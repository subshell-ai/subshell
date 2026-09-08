import type { Database } from "bun:sqlite";
import { DATABASE_PATH } from "@/constants.js";
import { openSqliteDatabase } from "@/db/open-database.js";

let handle: Database | null = null;

/**
 * Returns the shared auth database handle (the same file as the app DB).
 *
 * The auth connection is a separate handle from the app's Kysely one;
 * bun:sqlite supports multiple connections to one file with WAL for that.
 * It is opened lazily on first use and reused — opening a fresh connection
 * per call would redo the PRAGMAs and leak handles until GC. This is only
 * ever called after startup (migrations, auth mount), and the local
 * never-undefined return keeps the type honest (openSqliteDatabase is
 * typed as `Database | undefined` at the package boundary in some built
 * shapes, so we don't re-export that union here).
 */
export function authDatabase(): Database {
  if (!handle) {
    const db = openSqliteDatabase(DATABASE_PATH);
    if (!db) throw new Error("failed to open auth database");
    handle = db;
  }
  return handle;
}
