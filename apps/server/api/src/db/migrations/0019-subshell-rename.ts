import { type Kysely, sql } from "kysely";

/** True when the named table exists in this database. */
async function hasTable(db: Kysely<any>, name: string): Promise<boolean> {
  const r = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(
    db,
  );
  return r.rows.length > 0;
}

/** True when the named table has the named column. */
async function hasColumn(db: Kysely<any>, table: string, column: string): Promise<boolean> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}`.execute(
    db,
  );
  return r.rows.length > 0;
}

/**
 * Sessions → Subshells (spec 2026-09-02 §1.3): the entity's tables, columns
 * and indexes adopt the product vocabulary. SQLite rewrites REFERENCES
 * clauses on RENAME TO (legacy_alter_table is off), so the cascade FKs on
 * the renamed columns/tables follow without recreation.
 *
 * Every step is guarded on the object's existence because test suites hand-
 * build PARTIAL schemas (in-memory databases seeded with a chosen prefix of
 * the migration history); the guards make this migration a no-op for schema
 * a given database never had. Production runs see every guard pass.
 */
export async function up(db: Kysely<any>): Promise<void> {
  if ((await hasTable(db, "session_shares")) && !(await hasTable(db, "subshell_shares"))) {
    await db.schema.alterTable("session_shares").renameTo("subshell_shares").execute();
  }
  if ((await hasTable(db, "sessions")) && !(await hasTable(db, "subshells"))) {
    await db.schema.alterTable("sessions").renameTo("subshells").execute();
  }
  if (await hasColumn(db, "subshell_shares", "session_id")) {
    await db.schema.alterTable("subshell_shares").renameColumn("session_id", "subshell_id").execute();
  }
  if (await hasColumn(db, "workspace_panes", "session_id")) {
    await db.schema.alterTable("workspace_panes").renameColumn("session_id", "subshell_id").execute();
  }
  // SQLite has no ALTER INDEX RENAME — drop + recreate (definitions from 0001/0016/0017).
  await db.schema.dropIndex("idx_session_shares_session").ifExists().execute();
  if (await hasTable(db, "subshell_shares")) {
    await db.schema
      .createIndex("idx_subshell_shares_subshell")
      .ifNotExists()
      .on("subshell_shares")
      .column("subshell_id")
      .execute();
  }
  await db.schema.dropIndex("idx_sessions_user_created").ifExists().execute();
  if (await hasTable(db, "subshells")) {
    await db.schema
      .createIndex("idx_subshells_user_created")
      .ifNotExists()
      .on("subshells")
      .columns(["user_id", "created_at"])
      .execute();
    await db.schema.dropIndex("idx_sessions_node_status").ifExists().execute();
    // node_id only exists after 0017; partial seeds never had this index.
    if (await hasColumn(db, "subshells", "node_id")) {
      await db.schema
        .createIndex("idx_subshells_node_status")
        .ifNotExists()
        .on("subshells")
        .columns(["node_id", "status"])
        .execute();
    }
  }
  // Bearer-key metadata (persisted JSON): per-subshell tokens carry
  // {kind:"session", sessionId} — the discriminator auth-guard reads. Rewritten
  // to the new vocabulary so keys minted before this migration keep resolving.
  // Guarded on the table's existence: the apikey table belongs to better-auth
  // (applied before app migrations at boot, but not necessarily in every test
  // process), and an absent table means no keys exist to rewrite anyway.
  if (await hasTable(db, "apikey")) {
    await sql`
      UPDATE apikey
      SET metadata = json_patch(
        json_remove(metadata, '$.sessionId'),
        json_object('kind', 'subshell', 'subshellId', json_extract(metadata, '$.sessionId'))
      )
      WHERE json_extract(metadata, '$.kind') = 'session'
    `.execute(db);
    // Permission maps carry the resource key `sessions` (the requirePerm
    // vocabulary); in-flight keys must keep passing after the sweep.
    await sql`
      UPDATE apikey SET permissions = replace(permissions, '"sessions"', '"subshells"')
      WHERE permissions LIKE '%"sessions"%'
    `.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  if (await hasTable(db, "apikey")) {
    await sql`
      UPDATE apikey
      SET metadata = json_patch(
        json_remove(metadata, '$.subshellId'),
        json_object('kind', 'session', 'sessionId', json_extract(metadata, '$.subshellId'))
      )
      WHERE json_extract(metadata, '$.kind') = 'subshell'
    `.execute(db);
    await sql`
      UPDATE apikey SET permissions = replace(permissions, '"subshells"', '"sessions"')
      WHERE permissions LIKE '%"subshells"%'
    `.execute(db);
  }
  await db.schema.dropIndex("idx_subshell_shares_subshell").ifExists().execute();
  await db.schema.dropIndex("idx_subshells_user_created").ifExists().execute();
  await db.schema.dropIndex("idx_subshells_node_status").ifExists().execute();
  if (await hasColumn(db, "workspace_panes", "subshell_id")) {
    await db.schema.alterTable("workspace_panes").renameColumn("subshell_id", "session_id").execute();
  }
  if (await hasColumn(db, "subshell_shares", "subshell_id")) {
    await db.schema.alterTable("subshell_shares").renameColumn("subshell_id", "session_id").execute();
  }
  if ((await hasTable(db, "subshells")) && !(await hasTable(db, "sessions"))) {
    await db.schema.alterTable("subshells").renameTo("sessions").execute();
  }
  if ((await hasTable(db, "subshell_shares")) && !(await hasTable(db, "session_shares"))) {
    await db.schema.alterTable("subshell_shares").renameTo("session_shares").execute();
  }
  if (await hasTable(db, "session_shares")) {
    await db.schema
      .createIndex("idx_session_shares_session")
      .ifNotExists()
      .on("session_shares")
      .column("session_id")
      .execute();
  }
  if (await hasTable(db, "sessions")) {
    await db.schema
      .createIndex("idx_sessions_user_created")
      .ifNotExists()
      .on("sessions")
      .columns(["user_id", "created_at"])
      .execute();
    if (await hasColumn(db, "sessions", "node_id")) {
      await db.schema
        .createIndex("idx_sessions_node_status")
        .ifNotExists()
        .on("sessions")
        .columns(["node_id", "status"])
        .execute();
    }
  }
}
