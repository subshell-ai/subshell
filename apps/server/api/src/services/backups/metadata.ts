import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { assertSafeHostPath } from "./paths.js";

/** Independent metadata ceilings, so small inputs cannot produce enormous inspection responses. */
export const METADATA_LIMITS = {
  schemaObjects: 512,
  columns: 128,
  schemaBytes: 64 * 1024,
  migrations: 256,
  migrationBytes: 128,
  admins: 1024,
  idBytes: 256,
  emailBytes: 1024,
  nameBytes: 4096,
  jsonBytes: 1024 * 1024,
} as const;

type IndexColumn = { cid: number; name: string | null; key: number; desc: number; coll: string };

/** One partial index this build ships: its exact creating spelling, key for key. */
interface ShippedPartialIndex {
  /** Owning table */
  table: string;
  /** Index name (conveys nothing alone; matched alongside the stored SQL) */
  name: string;
  /** Whether the shipped index is UNIQUE (the workspaces rule's uniqueness, or the grants tuple's) */
  unique: 0 | 1;
  /** Key columns in order, ASC/BINARY like every shipped spelling */
  keys: string[];
  /** The normalized `sqlite_schema.sql` the migration literally writes */
  sql: RegExp;
}

/**
 * The shipped partial indexes, each one's literal predicate pinned. An index
 * name alone conveys no trust: the stored SQL must match the migration's
 * spelling, because the whole point of refusing partials is that inspection
 * never evaluates an ARCHIVE-chosen predicate - so only predicates THIS
 * build demonstrably wrote are safe. Entries in migration order:
 * 0029 (workspace drafts), 0047/0048 (the SSH active-state grammar -
 * revoked grants, running runs, outstanding execs all read as
 * `WHERE <state>` indexes, and the quota/recovery queries the SSH policy
 * asks depend on them existing exactly as shipped).
 */
const SHIPPED_PARTIAL_INDEXES: readonly ShippedPartialIndex[] = [
  {
    table: "workspaces",
    name: "idx_workspaces_user_name",
    unique: 1,
    keys: ["user_id", "name"],
    sql: /^CREATE UNIQUE INDEX (?:IF NOT EXISTS )?idx_workspaces_user_name ON workspaces\s*\(\s*user_id\s*,\s*name\s*\)\s*WHERE draft\s*=\s*0$/i,
  },
  {
    table: "ssh_grants",
    name: "uq_ssh_grants_active",
    unique: 1,
    keys: ["connection_id", "subshell_id", "api_key_id"],
    sql: /^CREATE UNIQUE INDEX (?:IF NOT EXISTS )?uq_ssh_grants_active ON ssh_grants\s*\(\s*connection_id\s*,\s*subshell_id\s*,\s*api_key_id\s*\)\s*WHERE revoked_at\s+IS NULL$/i,
  },
  {
    table: "ssh_grants",
    name: "idx_ssh_grants_pane",
    unique: 0,
    keys: ["subshell_id"],
    sql: /^CREATE INDEX (?:IF NOT EXISTS )?idx_ssh_grants_pane ON ssh_grants\s*\(\s*subshell_id\s*\)\s*WHERE revoked_at\s+IS NULL$/i,
  },
  {
    table: "ssh_runs",
    name: "idx_ssh_runs_active",
    unique: 0,
    keys: ["node_id", "user_id"],
    sql: /^CREATE INDEX (?:IF NOT EXISTS )?idx_ssh_runs_active ON ssh_runs\s*\(\s*node_id\s*,\s*user_id\s*\)\s*WHERE status IN\s*\(\s*'accepted'\s*,\s*'running'\s*\)$/i,
  },
  {
    table: "ssh_runs",
    name: "idx_ssh_runs_grant",
    unique: 0,
    keys: ["grant_id"],
    sql: /^CREATE INDEX (?:IF NOT EXISTS )?idx_ssh_runs_grant ON ssh_runs\s*\(\s*grant_id\s*\)\s*WHERE status IN\s*\(\s*'accepted'\s*,\s*'running'\s*\)$/i,
  },
  {
    table: "ssh_terminal_execs",
    name: "idx_ssh_terminal_execs_outstanding",
    unique: 0,
    keys: ["subshell_id"],
    sql: /^CREATE INDEX (?:IF NOT EXISTS )?idx_ssh_terminal_execs_outstanding ON ssh_terminal_execs\s*\(\s*subshell_id\s*\)\s*WHERE state\s*=\s*'outstanding'$/i,
  },
];

/** Only a shipped partial index's literal predicate is allowed; an index name alone conveys no trust. */
function isShippedPartialIndex(
  db: Database,
  table: string,
  index: { name: string; unique: number },
  columns: IndexColumn[],
): boolean {
  const spec = SHIPPED_PARTIAL_INDEXES.find(
    (shipped) => shipped.table === table && shipped.name === index.name && shipped.unique === index.unique,
  );
  if (!spec) return false;
  const keys = columns.filter((column) => column.key === 1);
  if (
    keys.length !== spec.keys.length ||
    keys.some(
      (column, position) =>
        column.cid < 0 || column.name !== spec.keys[position] || column.desc !== 0 || column.coll !== "BINARY",
    )
  )
    return false;
  const row = db
    .query("SELECT sql FROM sqlite_schema WHERE type='index' AND name=? AND tbl_name=?")
    .get(index.name, table) as { sql: string | null } | null;
  return typeof row?.sql === "string" && spec.sql.test(row.sql.trim().replace(/\s+/g, " "));
}

/** Validate schemas before inspection or writes can evaluate archived expressions. */
export function inspectSqliteSchema(db: Database): Map<string, Set<string>> {
  // Bun exposes neither sqlite3_limit nor a progress handler. Its handle is an internal index, not
  // a sqlite3 pointer. Bound query results and prohibit executable metadata schemas instead of FFI.
  db.exec(
    "PRAGMA trusted_schema=OFF; PRAGMA ignore_check_constraints=ON; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA mmap_size=0",
  );
  const count = db
    .query(`SELECT count(*) AS count FROM (SELECT 1 FROM sqlite_schema LIMIT ${METADATA_LIMITS.schemaObjects + 1})`)
    .get() as { count: number };
  if (count.count > METADATA_LIMITS.schemaObjects) throw new Error("backup SQLite schema exceeds metadata limit");
  if (db.query("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").get())
    throw new Error("backup SQLite triggers are refused");
  if (
    db
      .query(
        "SELECT 1 FROM sqlite_schema WHERE length(CAST(name AS BLOB)) > 128 OR length(CAST(sql AS BLOB)) > ? LIMIT 1",
      )
      .get(METADATA_LIMITS.schemaBytes)
  ) {
    throw new Error("backup SQLite schema exceeds metadata limit");
  }
  const tables = db
    .query(`SELECT name, type FROM pragma_table_list WHERE schema='main' LIMIT ${METADATA_LIMITS.schemaObjects + 1}`)
    .all() as { name: string; type: string }[];
  const result = new Map<string, Set<string>>();
  for (const table of tables) {
    if (table.type !== "table") throw new Error("backup SQLite schema must use ordinary tables");
    const columns = db
      .query(
        `SELECT substr(name, 1, 129) AS name, hidden FROM pragma_table_xinfo(?) LIMIT ${METADATA_LIMITS.columns + 1}`,
      )
      .all(table.name) as { name: string; hidden: number }[];
    if (columns.length > METADATA_LIMITS.columns || columns.some((column) => column.name.length > 128))
      throw new Error("backup SQLite columns exceed metadata limit");
    if (columns.some((column) => column.hidden !== 0)) throw new Error("backup SQLite generated columns are refused");
    const indexes = db
      .query(`SELECT name, "unique", partial FROM pragma_index_list(?) LIMIT ${METADATA_LIMITS.schemaObjects + 1}`)
      .all(table.name) as { name: string; unique: number; partial: number }[];
    if (indexes.length > METADATA_LIMITS.schemaObjects) throw new Error("backup SQLite indexes exceed metadata limit");
    for (const index of indexes) {
      const indexColumns = db
        .query(
          `SELECT cid, name, key, desc, coll FROM pragma_index_xinfo(?) ORDER BY seqno LIMIT ${METADATA_LIMITS.columns * 2 + 1}`,
        )
        .all(index.name) as IndexColumn[];
      if (indexColumns.length > METADATA_LIMITS.columns * 2)
        throw new Error("backup SQLite indexes exceed metadata limit");
      if (indexColumns.some((column) => column.cid === -2))
        throw new Error("backup SQLite expression indexes are refused");
      if (index.partial !== 0 && !isShippedPartialIndex(db, table.name, index, indexColumns))
        throw new Error("backup SQLite partial indexes are refused");
    }
    result.set(table.name, new Set(columns.map((column) => column.name)));
  }
  return result;
}

/** Verify fixed query columns exist in validated ordinary tables, including older snapshots. */
export function requireMetadataColumns(schema: Map<string, Set<string>>, table: string, columns: string[]): void {
  if (!columns.every((column) => schema.get(table)?.has(column)))
    throw new Error(`backup has unexpected ${table} metadata schema`);
}

/** Bound scalar outputs inside SQLite before they are materialized as JavaScript strings. */
export function boundedText(column: string, maxBytes: number): string {
  return `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) <= ${maxBytes} THEN substr(${column}, 1, ${maxBytes}) ELSE NULL END`;
}

/** Reject excess rows with a small count over a limited subquery, avoiding unbounded .all() results. */
export function requireMetadataRowLimit(db: Database, query: string, maxRows: number, label: string): void {
  const row = db.query(`SELECT count(*) AS count FROM (${query} LIMIT ${maxRows + 1})`).get() as { count: number };
  if (row.count > maxRows) throw new Error(`backup ${label} exceeds metadata row limit`);
}

/** Read JSON through a private regular-file handle with a small ceiling before allocating/parsing it. */
export async function readBackupMetadataJson(path: string): Promise<unknown> {
  await assertSafeHostPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > METADATA_LIMITS.jsonBytes)
      throw new Error("backup JSON metadata exceeds limit or is not regular");
    const buffer = Buffer.alloc(info.size + 1);
    let observed = 0;
    while (observed < buffer.length) {
      const result = await handle.read(buffer, observed, buffer.length - observed, observed);
      if (!result.bytesRead) break;
      observed += result.bytesRead;
    }
    if (observed !== info.size) throw new Error("backup JSON metadata changed during read");
    return JSON.parse(buffer.subarray(0, observed).toString("utf8"));
  } finally {
    await handle.close();
  }
}
