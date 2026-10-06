import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { up as up0047 } from "@/db/migrations/0047-ssh-connections.js";
import { up as up0048 } from "@/db/migrations/0048-ssh-execution.js";
import { up as up0049 } from "@/db/migrations/0049-ssh-runtime-sessions.js";
import { down as down0050, up as up0050 } from "@/db/migrations/0050-ssh-retirement.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * The retirement drop (design 2026-10-05 §7): applied OVER 0047/0048/0049 on
 * a chain that has created everything, 0050 removes EXACTLY the destination
 * product's five tables - and nothing of the replacement's. What this pins:
 * the five `ssh_*` destination tables are gone (indexes ride the SQLite
 * table drop), `ssh_runtime_sessions` and `nodes` survive untouched, the
 * drop is `IF EXISTS`-idempotent (the backup-restore path re-runs it on a
 * snapshot whose tables are already gone), and `down` refuses: retirement is
 * not reversible.
 */
describe("migration 0050-ssh-retirement", () => {
  let sqlite: ReturnType<typeof openSqliteDatabase>;
  let db: Kysely<Record<string, never>>;
  const dbFile = `/tmp/subshell-0050-${process.pid}-${Date.now()}.sqlite`;

  beforeAll(async () => {
    sqlite = openSqliteDatabase(dbFile);
    db = new Kysely<Record<string, never>>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    });
    await up0047(db);
    await up0048(db);
    await up0049(db);
  });

  afterAll(async () => {
    await db.destroy();
    sqlite.close();
    rmSync(dbFile, { force: true });
  });

  const tables = async (): Promise<Set<string>> => {
    const rows = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`.execute(db);
    return new Set(rows.rows.map((r) => r.name));
  };

  it("drops the five destination tables and keeps the replacement's", async () => {
    expect(await tables()).toContain("ssh_connections"); // 0047 created it
    await up0050(db);
    const after = await tables();
    for (const gone of ["ssh_connections", "ssh_grants", "ssh_runs", "ssh_panes", "ssh_terminal_execs"]) {
      expect(after.has(gone), `${gone} must be dropped`).toBe(false);
    }
    // `nodes` is asserted absent here on purpose: this suite runs 0047-0050
    // over an empty file (the FK target never exists in isolation), so the
    // replacement's table and nothing else must remain.
    expect([...after].sort()).toEqual(["ssh_runtime_sessions"]);
    // Indexes belong to the table: SQLite drops them with it, and a stale
    // index name would collide with nothing today but proves the intent.
    const idx = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_ssh_grants%' OR name LIKE 'idx_ssh_runs%' OR name LIKE 'idx_ssh_panes%')`.execute(
      db,
    );
    expect(idx.rows).toEqual([]);
  });

  it("re-runs cleanly on a database whose tables are already gone (restore path)", async () => {
    await up0050(db); // the restored-snapshot case
    expect((await tables()).has("ssh_connections")).toBe(false);
  });

  it("refuses the down half: retirement is not reversible", async () => {
    await expect(down0050(db)).rejects.toThrow(/not reversible/);
    // The chain below 0050 keeps its own reversibility (0047/0048/0049 each
    // pin their `down` in their own suites); re-running them AFTER the drop
    // would fight the missing tables. The point here is only that the
    // retirement itself has no undo.
  });
});

/**
 * The row sweep (review wave, design 2026-10-05 §7's deletion half): the old
 * managed terminals were ORDINARY `subshells` rows marked by an `ssh_panes`
 * record, and 0050 deletes exactly those before the marker table goes. On a
 * stub pane table (the 0048-suite shape: only `id` matters to the FK) with one
 * marked pane and two unmarked ones, this pins that the sweep removes the
 * marked row, spares every unmarked pane, and re-runs cleanly once its own
 * drop has removed `ssh_panes` (the restore-path idempotence the drop already
 * has, extended to the sweep's existence guard).
 */
describe("migration 0050 sweeps the ssh_panes-marked pane rows", () => {
  let sqlite: ReturnType<typeof openSqliteDatabase>;
  let db: Kysely<Record<string, never>>;
  const dbFile = `/tmp/subshell-0050-sweep-${process.pid}-${Date.now()}.sqlite`;

  const paneIds = async (): Promise<string[]> => {
    const rows = await sql<{ id: string }>`SELECT id FROM subshells ORDER BY id`.execute(db);
    return rows.rows.map((r) => r.id);
  };

  beforeAll(async () => {
    sqlite = openSqliteDatabase(dbFile);
    db = new Kysely<Record<string, never>>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    });
    await up0047(db);
    await up0048(db);
    await up0049(db);
    // The pane table the real chain has had since 0001/0019 (id plus whatever;
    // only `id` participates in the FK and the sweep), plus the config rows
    // the marker's own FKs require (the 0048-suite precedent).
    await sql`CREATE TABLE subshells (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE nodes (id TEXT PRIMARY KEY)`.execute(db);
    await sql`INSERT INTO nodes (id) VALUES ('n1')`.execute(db);
    await sql`INSERT INTO subshells (id) VALUES ('zombie'), ('ordinary-a'), ('ordinary-b')`.execute(db);
    await sql`INSERT INTO ssh_connections (id, user_id, node_id, display_name, config_snapshot)
      VALUES ('c1', 'u1', 'n1', 'S', '{"host":"h"}')`.execute(db);
    await sql`INSERT INTO ssh_panes (subshell_id, connection_id, connection_revision, initiated_by, control_owner)
      VALUES ('zombie', 'c1', 1, 'human', 'human')`.execute(db);
  });

  afterAll(async () => {
    await db.destroy();
    sqlite.close();
    rmSync(dbFile, { force: true });
  });

  it("deletes the marked pane and spares every unmarked pane", async () => {
    await up0050(db);
    expect(await paneIds()).toEqual(["ordinary-a", "ordinary-b"]);
  });

  it("re-runs cleanly after its own drop removed the marker table", async () => {
    await up0050(db); // ssh_panes is gone: the existence guard skips, nothing throws
    expect(await paneIds()).toEqual(["ordinary-a", "ordinary-b"]);
  });
});
