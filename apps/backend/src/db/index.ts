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
 */
export const db = new Kysely<Database>({
  dialect: new BunSqliteDialect({
    database: openSqliteDatabase(DATABASE_PATH),
  }),
  // sqlite_underscore <-> camelCase mapping (the scaffold used the same)
  plugins: [new CamelCasePlugin()],
});
