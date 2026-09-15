import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, listBackups, restoreDatabase } from "@/services/db-backup.js";

/**
 * Everything here runs against a temp database in a temp directory: the module
 * defaults to the CONFIGURED database and data dir, and a test that used those
 * would snapshot whatever instance the developer is running.
 */
let work = "";
let dbPath = "";
let dir = "";

/** A live WAL database with rows in it — the shape the snapshot has to survive. */
function seed(rows: number): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
  for (let i = 0; i < rows; i++) insert.run(`row-${i}`);
  return db;
}

/** Row count in whatever database is at `path`. */
function count(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "backup-test-"));
  dbPath = join(work, "subshell.db");
  dir = join(work, "backups");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("backupDatabase", () => {
  it("snapshots a LIVE WAL database with no sidecars beside the copy", async () => {
    // §12.1's measurement, as a regression test: the writer is still open, so
    // this is the real update case rather than a quiesced one.
    const live = seed(500);
    const backup = await backupDatabase({ reason: "update", version: "1.2.3", databasePath: dbPath, dir });
    expect(backup).not.toBeNull();
    const path = backup?.path as string;

    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(count(path)).toBe(500);
    const check = new Database(path, { readonly: true });
    expect(check.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    check.close();

    // Rows written AFTER the snapshot are not in it — the copy is of a moment,
    // which is exactly what makes a rollback mean something.
    live.prepare("INSERT INTO t (v) VALUES (?)").run("after");
    expect(count(path)).toBe(500);
    live.close();
  });

  it("writes 0600 in a 0700 directory", async () => {
    seed(1).close();
    const backup = await backupDatabase({ reason: "manual", databasePath: dbPath, dir });
    // SQLite creates the file with the process umask (0644 measured), so the
    // chmod is what makes this true. The file holds credential and API-key
    // hashes, audit rows and channel ciphertext.
    expect(statSync(backup?.path as string).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("repairs a loose directory mode rather than leaving it", async () => {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    seed(1).close();
    await backupDatabase({ reason: "manual", databasePath: dbPath, dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("names the file with the server version and a sortable timestamp", async () => {
    seed(1).close();
    const backup = await backupDatabase({
      reason: "update",
      version: "0.6.0",
      databasePath: dbPath,
      dir,
      now: () => new Date(Date.UTC(2026, 8, 15, 4, 5, 6)),
    });
    expect(backup?.path.endsWith("subshell-v0.6.0-20260915-040506.db")).toBe(true);
  });

  it("does not collide when two backups land in the same second", async () => {
    // `VACUUM INTO` REFUSES an existing file rather than overwriting it, so a
    // second update inside one second would fail for a reason that has nothing
    // to do with the update. Measured in this repo's own suite, 2026-09-15.
    seed(1).close();
    const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const first = await backupDatabase({ reason: "update", version: "1.0.0", databasePath: dbPath, dir, now: at });
    const second = await backupDatabase({ reason: "update", version: "1.0.0", databasePath: dbPath, dir, now: at });
    expect(second?.path).not.toBe(first?.path);
    expect(second?.path.endsWith("-000000-2.db")).toBe(true);
    // And the sequence sorts AFTER the un-suffixed one, so "newest first" holds.
    expect(listBackups(dir).map((b) => b.path)).toEqual([second?.path as string, first?.path as string]);
  });

  it("answers null when there is no database yet", async () => {
    // A fresh install that has never booted — a real state on the update path,
    // so the caller says so rather than failing.
    expect(await backupDatabase({ reason: "update", databasePath: join(work, "nothing.db"), dir })).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("prunes to the retention count, newest kept", async () => {
    seed(1).close();
    for (let i = 0; i < 5; i++) {
      await backupDatabase({
        reason: "update",
        version: `0.0.${i}`,
        databasePath: dbPath,
        dir,
        keep: 3,
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    const kept = listBackups(dir).map((b) => b.path.slice(-9));
    // Newest first, and the two oldest are gone.
    expect(kept).toEqual(["000004.db", "000003.db", "000002.db"]);
  });

  it("keeps everything when the retention count is 0", async () => {
    seed(1).close();
    for (let i = 0; i < 4; i++) {
      await backupDatabase({
        reason: "manual",
        databasePath: dbPath,
        dir,
        keep: 0,
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    expect(listBackups(dir)).toHaveLength(4);
  });
});

describe("listBackups", () => {
  it("is empty rather than an error when nothing has ever been backed up", () => {
    expect(listBackups(join(work, "never"))).toEqual([]);
  });

  it("ignores files the operator put there", async () => {
    seed(1).close();
    await backupDatabase({ reason: "manual", databasePath: dbPath, dir });
    writeFileSync(join(dir, "notes.txt"), "mine");
    writeFileSync(join(dir, "subshell.db"), "also mine");
    // Only the name shape this module writes is listed — and therefore only
    // that shape is ever pruned.
    expect(listBackups(dir)).toHaveLength(1);
  });

  it("orders newest first by the name's own timestamp", async () => {
    seed(1).close();
    for (const second of [0, 2, 1]) {
      await backupDatabase({
        reason: "manual",
        version: "1.0.0",
        databasePath: dbPath,
        dir,
        keep: 0,
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
      });
    }
    expect(listBackups(dir).map((b) => b.path.slice(-9))).toEqual(["000002.db", "000001.db", "000000.db"]);
  });
});

describe("restoreDatabase", () => {
  it("replaces the live database and its sidecars with the snapshot", async () => {
    const live = seed(10);
    const backup = await backupDatabase({ reason: "update", databasePath: dbPath, dir });
    // The update's migrations run, more rows land, and then the boot fails.
    live.prepare("INSERT INTO t (v) VALUES (?)").run("migrated");
    expect(count(dbPath)).toBe(11);
    live.close();
    // A stale WAL beside a restored main file would replay transactions the
    // snapshot never had, so both sidecars go.
    writeFileSync(`${dbPath}-wal`, "stale");
    writeFileSync(`${dbPath}-shm`, "stale");

    restoreDatabase(backup?.path as string, dbPath);

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(count(dbPath)).toBe(10);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it("refuses a backup that is not there rather than deleting the database", () => {
    seed(3).close();
    expect(() => restoreDatabase(join(work, "no-such-backup.db"), dbPath)).toThrow(/is not there/);
    // The live database is untouched: the refusal fires before the first unlink.
    expect(count(dbPath)).toBe(3);
  });

  it("leaves nothing else in the backups directory", async () => {
    seed(2).close();
    const backup = await backupDatabase({ reason: "manual", databasePath: dbPath, dir });
    restoreDatabase(backup?.path as string, dbPath);
    // A restore consumes nothing: the same snapshot can be restored again.
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
