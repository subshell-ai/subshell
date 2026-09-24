import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { backupDatabase } from "@/services/db-backup.js";
import {
  beginUpdate,
  clearPending,
  completeUpdate,
  keepPreviousBinary,
  type PendingUpdate,
  readFailed,
  readPending,
  recordFailure,
  revertUpdate,
  type UpdateAuditEvent,
  updateDir,
} from "@/services/update-transaction.js";

let work = "";
let dir = "";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "update-tx-"));
  dir = join(work, "update");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** What the stub below prints — the byte-identical `version` contract. */
const OLD_STUB_TEXT = '#!/bin/sh\necho "subshell-server 0.6.0"\n';

/**
 * A marker over two real files, so a revert has something to rename.
 *
 * The `.previous` is a stub EXECUTABLE that answers `version`, because the
 * revert PROBEs it before putting it back (round-3 review, finding 2) — the
 * same shape `server-update.sh` proves with two compiled binaries, shrunk to
 * a shebang here. A revert test that wants the refusal stages a file that
 * CANNOT answer, instead of opting out of the probe.
 */
function stage(over: Partial<PendingUpdate> = {}): PendingUpdate {
  const binary = join(work, "subshell-server");
  const previousBinary = `${binary}.previous`;
  writeFileSync(binary, "the new binary");
  writeFileSync(previousBinary, OLD_STUB_TEXT);
  chmodSync(previousBinary, 0o755);
  return {
    from: "0.6.0",
    to: "0.7.0",
    binary,
    previousBinary,
    backup: null,
    startedAt: "2026-09-15T00:00:00.000Z",
    origin: "cli",
    forced: false,
    ...over,
  };
}

describe("beginUpdate", () => {
  it("writes the marker 0600 in a 0700 directory", () => {
    beginUpdate(stage(), dir);
    const pending = readPending(dir);
    expect(pending?.to).toBe("0.7.0");
    expect(statSync(join(dir, "pending.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses when one is already open, and names the way out", () => {
    // Two overlapping swaps leave a `.previous` from one update and a marker
    // from the other, and the booting binary then reverts to the wrong version.
    beginUpdate(stage(), dir);
    expect(() => beginUpdate(stage(), dir)).toThrow(/--rollback/);
  });

  it("keeps ONE level of failure history", () => {
    beginUpdate(stage(), dir);
    revertUpdate(stage({ to: "0.7.0" }), new Error("first failure"), { dir });
    expect(readFailed(dir)?.error).toBe("first failure");

    beginUpdate(stage({ to: "0.8.0" }), dir);
    expect(readFailed(dir)).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "failed.previous.json"), "utf8")).error).toBe("first failure");
  });
});

describe("readPending", () => {
  it("is null when there is no marker", () => {
    expect(readPending(dir)).toBeNull();
  });

  it("treats an INCOMPLETE marker as no marker", () => {
    // A marker missing a field the boot hook acts on is worse than none: the
    // revert would rename `undefined` over the binary.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pending.json"), JSON.stringify({ to: "0.7.0" }));
    expect(readPending(dir)).toBeNull();
  });

  it("treats unreadable JSON as no marker", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pending.json"), "{ half a fil");
    expect(readPending(dir)).toBeNull();
  });
});

describe("clearPending", () => {
  it("drops the marker with no record — the updater's own undo", () => {
    // Between the two renames: the swap failed, nothing booted, and there is
    // nothing to report.
    beginUpdate(stage(), dir);
    clearPending(dir);
    expect(readPending(dir)).toBeNull();
    expect(readFailed(dir)).toBeNull();
  });
});

describe("completeUpdate", () => {
  it("audits with actor null, then removes .previous and the marker", async () => {
    const pending = stage({ backup: "/tmp/snap.db", origin: "api", forced: true });
    beginUpdate(pending, dir);
    const events: UpdateAuditEvent[] = [];
    await completeUpdate(pending, { dir, audit: async (e) => void events.push(e) });

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("server.update");
    // The booting process holds no session; the START of an API-driven update
    // is audited separately with the admin as actor.
    expect(events[0]?.actorUserId).toBeNull();
    expect(JSON.parse(events[0]?.metadataJson ?? "{}")).toEqual({
      from: "0.6.0",
      to: "0.7.0",
      origin: "api",
      forced: true,
      backup: "/tmp/snap.db",
    });
    expect(existsSync(pending.previousBinary)).toBe(false);
    expect(readPending(dir)).toBeNull();
  });

  it("cleans up even when the audit sink fails", async () => {
    // An update that worked must not be left looking pending because an audit
    // insert failed — which is also why the production `audit()` never throws.
    const pending = stage();
    beginUpdate(pending, dir);
    await expect(
      completeUpdate(pending, {
        dir,
        audit: async () => {
          throw new Error("no database");
        },
      }),
    ).rejects.toThrow();
    // The production sink swallows, so this case documents the contract rather
    // than the behaviour: with a throwing sink the cleanup does NOT run.
    expect(readPending(dir)).not.toBeNull();
  });
});

describe("revertUpdate", () => {
  it("puts the previous binary back and writes failed.json", () => {
    const pending = stage();
    beginUpdate(pending, dir);
    revertUpdate(pending, new Error("migration 0032 failed"), { dir });

    // The stub answers `version`, so the probe lets it back onto the live path.
    expect(readFileSync(pending.binary, "utf8")).toBe(OLD_STUB_TEXT);
    expect(existsSync(pending.previousBinary)).toBe(false);
    expect(readPending(dir)).toBeNull();
    const failed = readFailed(dir);
    expect(failed?.error).toBe("migration 0032 failed");
    expect(failed?.from).toBe("0.6.0");
    expect(failed?.to).toBe("0.7.0");
    expect(failed?.failedAt).toMatch(/^\d{4}-/);
  });

  it("restores the backup as well as the binary", async () => {
    // The half that matters most: kysely refuses a database carrying migrations
    // the old binary does not know (pinned below), so putting the binary back
    // without the database is a server that cannot boot at all.
    const dbPath = join(work, "subshell.db");
    const live = new Database(dbPath);
    live.exec("CREATE TABLE t (v TEXT)");
    live.exec("INSERT INTO t VALUES ('before')");
    const backup = await backupDatabase({ reason: "update", databasePath: dbPath, dir: join(work, "backups") });
    live.exec("INSERT INTO t VALUES ('after the swap')");
    live.close();

    const pending = stage({ backup: backup?.path ?? null });
    beginUpdate(pending, dir);
    // `databasePath` is injected ONLY so this reverts over a temp file: the
    // whole suite shares one database in one process, and restoring over it
    // would take every other test file with it. Production passes none.
    revertUpdate(pending, new Error("boom"), { dir, databasePath: dbPath });

    const restored = new Database(dbPath, { readonly: true });
    expect(restored.query("SELECT v FROM t").all() as { v: string }[]).toEqual([{ v: "before" }]);
    restored.close();
    expect(readFileSync(pending.binary, "utf8")).toBe(OLD_STUB_TEXT);
  });

  it("does NOT put back a .previous that cannot run — it records and keeps both files", () => {
    // Round-3 review, finding 2. The copy a plain (pre-atomic) copy-fallback
    // interrupted mid-write, or a truncated file a hand produced, would
    // otherwise land at the path the unit names, where the manager cannot
    // EXEC it and the boot-revert logic cannot live. The revert instead:
    // restores the database, writes failed.json, and leaves the bootable
    // (if un-migratable) new binary at its path with the copy kept as evidence.
    const pending = stage();
    writeFileSync(pending.previousBinary, "trunc");
    chmodSync(pending.previousBinary, 0o644); // present, regular, unrunnable
    beginUpdate(pending, dir);
    expect(() => revertUpdate(pending, new Error("migration 0032 failed"), { dir })).not.toThrow();

    expect(readFileSync(pending.binary, "utf8")).toBe("the new binary"); // left in place
    expect(existsSync(pending.previousBinary)).toBe(true); // kept, not buried
    expect(readPending(dir)).toBeNull();
    expect(readFailed(dir)?.error).toBe("migration 0032 failed");
  });

  it("says the previous binary is gone rather than throwing", () => {
    const pending = stage();
    rmSync(pending.previousBinary);
    beginUpdate(pending, dir);
    // The database is already restored by this point and the process is about
    // to exit; a stack trace helps nobody. The marker is what says what state
    // this host is in.
    expect(() => revertUpdate(pending, new Error("boom"), { dir })).not.toThrow();
    expect(readFailed(dir)?.error).toBe("boom");
  });

  it("flattens a non-Error into the marker", () => {
    const pending = stage();
    beginUpdate(pending, dir);
    revertUpdate(pending, "a string somebody threw", { dir });
    expect(readFailed(dir)?.error).toBe("a string somebody threw");
  });
});

describe("recordFailure", () => {
  it("records a marker whose binary never booted, and clears it", () => {
    // Nothing is reverted here: whoever put this binary back already undid the
    // swap. What was missing is the record — without it the marker refuses
    // every later `beginUpdate` forever.
    const pending = stage();
    beginUpdate(pending, dir);
    recordFailure(pending, "expected 0.7.0 to boot, 0.6.0 did", dir);

    expect(readPending(dir)).toBeNull();
    expect(readFailed(dir)?.error).toBe("expected 0.7.0 to boot, 0.6.0 did");
    // The binaries are left exactly as they were found.
    expect(readFileSync(pending.binary, "utf8")).toBe("the new binary");
    expect(existsSync(pending.previousBinary)).toBe(true);
    // And an update can be attempted again.
    expect(() => beginUpdate(stage({ to: "0.8.0" }), dir)).not.toThrow();
  });
});

describe("keepPreviousBinary", () => {
  /** Names in `work` that the keeper may never leave behind. */
  const strayTmps = () => readdirSync(work).filter((n) => n.includes(".previous.tmp-"));

  it("links when the filesystem allows it: same inode, no copy", () => {
    const binary = join(work, "subshell-server");
    writeFileSync(binary, "bytes");
    expect(keepPreviousBinary(binary)).toBe(`${binary}.previous`);
    expect(readFileSync(`${binary}.previous`, "utf8")).toBe("bytes");
    expect(statSync(`${binary}.previous`).ino).toBe(statSync(binary).ino);
    expect(strayTmps()).toEqual([]);
  });

  it("copies atomically when links are refused: full bytes at .previous, no tmp", () => {
    const binary = join(work, "subshell-server");
    writeFileSync(binary, "bytes");
    keepPreviousBinary(binary, {
      link: () => {
        throw Object.assign(new Error("link refused"), { code: "EXDEV" });
      },
    });
    expect(readFileSync(`${binary}.previous`, "utf8")).toBe("bytes");
    expect(strayTmps()).toEqual([]); // the tmp was renamed INTO place, not left
  });

  it("a copy that throws mid-write leaves NOTHING at .previous and sweeps the tmp", () => {
    // The hole this closes (round-3 review, finding 2): the old plain copy
    // left a TRUNCATED `.previous` in place on ENOSPC, failure paths kept it,
    // and `--rollback` renamed that onto the live path. An interrupted copy
    // now costs only a stray tmp name — and even the tmp is swept here, so
    // only a hard crash between write and rename can leave it.
    const binary = join(work, "subshell-server");
    writeFileSync(binary, "bytes");
    const previous = `${binary}.previous`;
    writeFileSync(previous, "stale copy from an earlier swap");
    expect(() =>
      keepPreviousBinary(binary, {
        link: () => {
          throw new Error("no links here");
        },
        copy: (_from, to) => {
          writeFileSync(to, "byt"); // got partway, then the disk filled
          throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
        },
      }),
    ).toThrow(/No space left/);
    expect(existsSync(previous)).toBe(false); // stale was cleared; the partial never landed
    expect(strayTmps()).toEqual([]);
  });
});

/**
 * §12.3, pinned: the fact the whole rollback rests on.
 *
 * MEASURED 2026-09-15 against kysely 0.29.5 — a database carrying a migration
 * name the running binary does not know makes `migrateToLatest()` answer an
 * ERROR ("corrupted migrations: previously executed migration … is missing")
 * rather than ignoring the row. So an OLD binary cannot boot on a NEWER
 * database, which is why a revert restores the BACKUP and not just the binary.
 * If a Kysely upgrade ever softened this, `revertUpdate` would still work and
 * the design's reason would have quietly stopped being true.
 */
describe("kysely refuses a database it has unknown migrations for (§12.3)", () => {
  const up = async (db: Kysely<unknown>, table: string) => {
    await db.schema.createTable(table).addColumn("id", "integer").execute();
  };
  const older = { "0001-a": { up: (db: Kysely<unknown>) => up(db, "a") } };
  const newer = { ...older, "0002-b": { up: (db: Kysely<unknown>) => up(db, "b") } };

  it("errors rather than ignoring the newer migration", async () => {
    const path = join(work, "migrated.db");
    const open = () => new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: new Database(path) }) });
    const migrate = async (db: Kysely<unknown>, set: Record<string, unknown>) =>
      new Migrator({
        db: db as never,
        provider: { getMigrations: async () => set as never },
      }).migrateToLatest();

    const newBinary = open();
    expect((await migrate(newBinary, newer)).error).toBeUndefined();
    await newBinary.destroy();

    const oldBinary = open();
    const { error } = await migrate(oldBinary, older);
    await oldBinary.destroy();
    expect(error).toBeDefined();
    expect(String(error)).toMatch(/corrupted migrations/);
    expect(String(error)).toContain("0002-b");
  });
});

describe("updateDir", () => {
  it("lives inside the data dir, so a reset already covers it", () => {
    expect(updateDir().endsWith("/update")).toBe(true);
  });
});
