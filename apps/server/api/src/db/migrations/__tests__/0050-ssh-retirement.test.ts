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
