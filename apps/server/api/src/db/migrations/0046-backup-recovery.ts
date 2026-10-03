import { type Kysely, sql } from "kysely";

/** Also created by offline restore when recovering an older snapshot. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS backup_recovery (user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS backup_recovery`.execute(db);
}
