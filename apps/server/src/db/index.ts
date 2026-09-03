import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { DATABASE_PATH } from "@/constants.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import type { Database } from "@/db/types/index.js";

/**
 * Application database: a single bun:sqlite file (see constants for the path).
 * Kysely is used for type-safe queries; the dialect comes from
 * `kysely-bun-sqlite-dialect` (bun-native, no native modules), and every handle
 * is opened through `openSqliteDatabase` so the foreign-key pragma is applied.
 *
 * The handle opens LAZILY via the dialect's factory contract ("called once,
 * when the first query is executed"): merely importing this module must not
 * mkdir the data dir or create the SQLite file — the `subshell-server` CLI
 * (`version`/`status`, plan 2) shares the entry import graph, and an
 * import-time open would litter whatever directory the operator ran it from.
 */
export const db = new Kysely<Database>({
  dialect: new BunSqliteDialect({
    database: async () => openSqliteDatabase(DATABASE_PATH),
  }),
  // sqlite_underscore <-> camelCase mapping (the scaffold used the same)
  plugins: [new CamelCasePlugin()],
});
