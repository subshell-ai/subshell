import type { Kysely } from "kysely";
import type { Database } from "@/db/types/index.js";

/**
 * Common base for repositories. Repositories own queries against the
 * application database; they mutate nothing outside their table.
 */
export class BaseRepository {
  readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }
}
