import { type Kysely, sql } from "kysely";

/**
 * Initial schema: harness plugin states, profiles, sessions, recent paths,
 * settings, and user roles. All app tables carry a user_id for the future
 * multi-user model; better-auth manages its own user/session/account tables.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("harness_plugins")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createTable("profiles")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("harness_id", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("env_json", "text")
    .addColumn("flags_json", "text")
    .addColumn("settings_json", "text")
    .addColumn("config_isolation", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema.createIndex("idx_profiles_user_harness").on("profiles").columns(["user_id", "harness_id"]).execute();

  await db.schema
    .createTable("sessions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("profile_id", "text", (col) => col.notNull())
    .addColumn("harness_id", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("working_dir", "text", (col) => col.notNull())
    .addColumn("tmux_socket", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("running"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("ended_at", "text")
    .execute();

  await db.schema.createIndex("idx_sessions_user_created").on("sessions").columns(["user_id", "created_at"]).execute();

  await db.schema
    .createTable("recent_paths")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("path", "text", (col) => col.notNull())
    .addColumn("label", "text")
    .addColumn("last_used_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createIndex("idx_recent_paths_user_path")
    .on("recent_paths")
    .columns(["user_id", "path"])
    .unique()
    .execute();

  await db.schema
    .createTable("settings")
    .addColumn("key", "text", (col) => col.primaryKey())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createTable("user_meta")
    .addColumn("user_id", "text", (col) => col.primaryKey())
    .addColumn("role", "text", (col) => col.notNull().defaultTo("user"))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("user_meta").execute();
  await db.schema.dropTable("settings").execute();
  await db.schema.dropTable("recent_paths").execute();
  await db.schema.dropTable("sessions").execute();
  await db.schema.dropTable("profiles").execute();
  await db.schema.dropTable("harness_plugins").execute();
}
