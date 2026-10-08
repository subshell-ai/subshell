import { Database } from "bun:sqlite";
import { chmod, lstat, rm } from "node:fs/promises";
import {
  boundedText,
  inspectSqliteSchema,
  METADATA_LIMITS,
  requireMetadataColumns,
  requireMetadataRowLimit,
} from "./metadata.js";
import { assertSafeHostPath } from "./paths.js";
import type { BackupAdmin } from "./types.js";

/** Latest supported application migration; its registration is pinned by the engine tests. */
export const LATEST_BACKUP_MIGRATION = "0047-node-ssh-enabled";

/** Snapshot a live SQLite database using VACUUM INTO, including committed WAL state. */
export async function snapshotDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  await assertSafeHostPath(sourcePath);
  if (!(await lstat(sourcePath)).isFile()) throw new Error("database source must be a regular file");
  const db = new Database(sourcePath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`VACUUM INTO '${destinationPath.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  await chmod(destinationPath, 0o600);
}

/** Integrity and migration inspection, with only public administrator identifiers returned. */
export function inspectDatabase(path: string): { migrations: string[]; admins: BackupAdmin[] } {
  const db = new Database(path, { readonly: true });
  try {
    const schema = inspectSqliteSchema(db);
    requireMetadataColumns(schema, "kysely_migration", ["name"]);
    requireMetadataColumns(schema, "user", ["id", "email", "name"]);
    requireMetadataColumns(schema, "user_meta", ["user_id", "role"]);
    // quick_check verifies structural/page/record integrity without recomputing attacker-chosen
    // expression/partial indexes. CHECK evaluation is disabled on this inspection connection.
    const integrity = db
      .query("SELECT substr(quick_check, 1, 4096) AS result FROM pragma_quick_check LIMIT 1")
      .get() as { result: string } | null;
    if (integrity?.result !== "ok") throw new Error("backup database is corrupt");
    requireMetadataRowLimit(db, "SELECT 1 FROM kysely_migration", METADATA_LIMITS.migrations, "migration history");
    const rows = db
      .query(
        `SELECT ${boundedText("name", METADATA_LIMITS.migrationBytes)} AS name FROM kysely_migration LIMIT ${METADATA_LIMITS.migrations}`,
      )
      .all() as { name: string | null }[];
    if (rows.some((row) => row.name === null)) throw new Error("backup migration scalar exceeds metadata limit");
    const migrations = rows.map((row) => row.name as string).sort();
    validateMigrations(migrations);
    const adminsQuery = "FROM \"user\" u JOIN user_meta m ON m.user_id=u.id WHERE m.role='admin'";
    requireMetadataRowLimit(db, `SELECT 1 ${adminsQuery}`, METADATA_LIMITS.admins, "administrators");
    const rawAdmins = db
      .query(
        `SELECT ${boundedText("u.id", METADATA_LIMITS.idBytes)} AS id, ${boundedText("u.email", METADATA_LIMITS.emailBytes)} AS email, ${boundedText("u.name", METADATA_LIMITS.nameBytes)} AS name ${adminsQuery} LIMIT ${METADATA_LIMITS.admins}`,
      )
      .all() as { id: string | null; email: string | null; name: string | null }[];
    if (rawAdmins.some((row) => row.id === null || row.email === null || row.name === null))
      throw new Error("backup administrator scalar exceeds metadata limit");
    const admins = (rawAdmins as BackupAdmin[]).sort((a, b) => a.email.localeCompare(b.email));
    return { migrations, admins };
  } finally {
    db.close();
  }
}

/** Identity files required by enrolled nodes and locally registered channel principals. Remote files are excluded. */
export function requiredIdentityPaths(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const schema = inspectSqliteSchema(db);
    const tables = new Set(schema.keys());
    const required: string[] = [];
    if (tables.has("nodes")) {
      requireMetadataColumns(schema, "nodes", ["kind", "public_key"]);
      const columns = schema.get("nodes") as Set<string>;
      if (db.query("SELECT 1 FROM nodes WHERE kind='agent' AND public_key IS NOT NULL LIMIT 1").get())
        required.push("data/node-signing.json");
      if (
        columns.has("encrypt_public_key") &&
        db.query("SELECT 1 FROM nodes WHERE kind='agent' AND encrypt_public_key IS NOT NULL LIMIT 1").get()
      ) {
        required.push("data/node-encryption.json");
      }
    }
    const panes = tables.has("subshells") ? "subshells" : tables.has("sessions") ? "sessions" : null;
    if (tables.has("identities") && panes) {
      requireMetadataColumns(schema, "identities", ["principal_id"]);
      requireMetadataColumns(schema, panes, ["id"]);
      const columns = schema.get(panes) as Set<string>;
      const rows = db
        .query(
          `SELECT ${boundedText("i.principal_id", METADATA_LIMITS.idBytes)} AS principal_id FROM identities i JOIN ${panes} p ON i.principal_id = 'sess:' || p.id ${columns.has("node_id") ? "WHERE p.node_id='local'" : ""} LIMIT 50001`,
        )
        .all() as { principal_id: string | null }[];
      if (rows.length > 50000) throw new Error("backup identity count exceeds limit");
      if (rows.some((row) => row.principal_id === null))
        throw new Error("backup identity scalar exceeds metadata limit");
      for (const row of rows)
        required.push(`data/identities/${(row.principal_id as string).replace(/[^a-zA-Z0-9._-]/g, "-")}.json`);
    }
    return required;
  } finally {
    db.close();
  }
}

/** Older snapshots migrate forward at boot; newer application schemas are refused before replacement. */
export function validateMigrations(migrations: string[]): void {
  if (!migrations.length || migrations.some((name) => !/^\d{4}-[a-z0-9-]+$/.test(name))) {
    throw new Error("invalid backup migration history");
  }
  if (migrations.some((name) => name > LATEST_BACKUP_MIGRATION)) {
    throw new Error("backup requires a newer server migration level");
  }
  if (new Set(migrations).size !== migrations.length) throw new Error("duplicate backup migrations");
}

/** Recover/checkpoint before removing sidecars; a busy database refuses replacement. Caller must be offline. */
export async function checkpointDatabase(path: string): Promise<void> {
  await assertSafeHostPath(path);
  const sidecars = ["-journal", "-wal", "-shm"].map((suffix) => `${path}${suffix}`);
  // SQLite may read/write a hot rollback journal while opening the main file; validate first.
  for (const sidecar of sidecars) await assertSafeHostPath(sidecar);
  try {
    if (!(await lstat(path)).isFile()) throw new Error("database destination must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Orphan journals/WAL must never replay onto a freshly installed snapshot.
    for (const sidecar of sidecars) await rm(sidecar, { force: true });
    return;
  }
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // A real database read recovers DELETE-mode hot journals; wal_checkpoint alone does not.
    db.query("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
    db.exec("BEGIN EXCLUSIVE; COMMIT");
    const status = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    if (status.busy !== 0) throw new Error("database is busy; stop the server before restoring");
  } finally {
    db.close();
  }
  for (const sidecar of sidecars) await rm(sidecar, { force: true });
}
