import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { collectStatus } from "@/commands/status.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { Database as Database_ } from "@/db/types/index.js";

/**
 * `collectStatus` takes no config dir — it reads `SUBSHELL_SERVER_CONFIG_DIR`
 * through `serverConfigDir()`, which is exactly why an unpinned test reaches
 * the operator's own config.env in the first place. So the env is what this
 * helper sets, and restores.
 */
function statusFor(dbPath: string) {
  const configDir = mkdtempSync(join(tmpdir(), "status-db-"));
  writeFileSync(join(configDir, "config.env"), `DATABASE_PATH=${dbPath}\n`, "utf8");
  const prev = process.env.SUBSHELL_SERVER_CONFIG_DIR;
  process.env.SUBSHELL_SERVER_CONFIG_DIR = configDir;
  try {
    return collectStatus({ platform: "linux", probePort: () => null });
  } finally {
    if (prev === undefined) delete process.env.SUBSHELL_SERVER_CONFIG_DIR;
    else process.env.SUBSHELL_SERVER_CONFIG_DIR = prev;
  }
}

/**
 * `status` must never open the DEVELOPER'S live database from a test.
 *
 * It resolves `DATABASE_PATH` out of config.env, so a test that does not pin
 * `SUBSHELL_SERVER_CONFIG_DIR` reads `~/.config/subshell-server/config.env` and
 * opens whatever instance the operator actually runs — and the read-write
 * fallback (needed because SQLite cannot read a WAL database without a
 * writable `-shm`) then creates that instance's sidecars.
 *
 * Measured on 2026-09-15: the suite was touching the operator's live database
 * on every run, which is how this test came to exist.
 */
describe("status never reads a database outside the temp dir under test", () => {
  it("reports a temp database it can actually read", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-db-real-"));
    const dbPath = join(dir, "subshell.db");
    const db = new Database(dbPath, { create: true });
    db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)`);
    db.run(`INSERT INTO "user" (id, email) VALUES ('u1', 'u1@subshell.local')`);
    db.close();

    const view = statusFor(dbPath);
    expect(view.setup.database).toBe("present");
    expect(view.setup.hasUsers).toBe(true);
  });

  it("refuses a path outside the temp dir, naming it unreadable rather than opening it", () => {
    // The operator's own instance, as config.env would name it. The file may
    // not exist on this machine; what matters is that the guard answers before
    // any open is attempted, so the assertion holds either way.
    const live = join(homedir(), ".config", "subshell-server", "subshell.db");
    const view = statusFor(live);
    expect(view.setup.hasUsers).toBeNull();
  });
});

/**
 * The CLI's account counter and the repository's are two hand-written copies
 * of one rule — count `"user"` rows whose email is not the service account's.
 *
 * They HAVE to be two: `collectStatus` is synchronous and opens an arbitrary
 * path through `bun:sqlite` with a read-only → read-write fallback and a
 * never-throw contract, none of which the app's Kysely handle can give it. So
 * the duplication stays, and this is what keeps "the two cannot disagree"
 * a fact rather than a convention: one database file, both implementations,
 * same answer.
 */
describe("the CLI counter and the repository counter agree", () => {
  /** Better-auth's `user` table, as `runAuthMigrations` creates it. */
  function seedUsers(dbPath: string, emails: string[]): void {
    const db = new Database(dbPath, { create: true });
    db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)`);
    for (const email of emails) db.run(`INSERT INTO "user" (id, email) VALUES (?, ?)`, [crypto.randomUUID(), email]);
    db.close();
  }

  /** The repository's answer for the same file, through the app's real stack. */
  async function repositoryCount(dbPath: string): Promise<number> {
    const kysely = new Kysely<Database_>({
      dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbPath) }),
      plugins: [new CamelCasePlugin()],
    });
    try {
      return await new UsersRepository(kysely).countRealAccounts();
    } finally {
      await kysely.destroy();
    }
  }

  // The service account is in every case because `ensureSystemUser()` runs on
  // every boot, before the server listens — so "a user row exists" is true of
  // an instance nobody has ever signed up on, and both counters have to say so.
  for (const [name, emails, accounts] of [
    ["the service account alone", [SYSTEM_USER_EMAIL], 0],
    ["one real account beside it", [SYSTEM_USER_EMAIL, "a@subshell.local"], 1],
    ["two real accounts beside it", [SYSTEM_USER_EMAIL, "a@subshell.local", "b@subshell.local"], 2],
  ] as const) {
    it(`agrees on ${name}`, async () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), "status-agree-")), "subshell.db");
      seedUsers(dbPath, [...emails]);

      expect(await repositoryCount(dbPath)).toBe(accounts);
      expect(statusFor(dbPath).setup.hasUsers).toBe(accounts > 0);
    });
  }

  it("reads a database whose auth tables do not exist yet as EMPTY, not unreadable", async () => {
    // A boot that died between `runMigrations` and `runAuthMigrations` — one
    // line apart in index.ts — leaves app tables and no `"user"`. That file is
    // perfectly readable, and `null` renders as "database present but
    // unreadable", which sends the one operator most likely to be running
    // `status` looking for disk corruption.
    const dbPath = join(mkdtempSync(join(tmpdir(), "status-halfmig-")), "subshell.db");
    const db = new Database(dbPath, { create: true });
    db.run(`CREATE TABLE kysely_migration (name TEXT PRIMARY KEY, timestamp TEXT NOT NULL)`);
    db.run(`CREATE TABLE user_meta (user_id TEXT PRIMARY KEY, role TEXT NOT NULL)`);
    db.close();

    expect(statusFor(dbPath).setup.hasUsers).toBe(false);
  });

  it("still answers UNREADABLE for a file that is not a subshell database", async () => {
    // The other half of the rule: no `"user"` table AND no migration ledger is
    // not an empty instance, it is a file this command should not be guessing
    // about. Answering `false` here would advertise the setup wizard over
    // somebody's unrelated sqlite file.
    const dbPath = join(mkdtempSync(join(tmpdir(), "status-foreign-")), "subshell.db");
    const db = new Database(dbPath, { create: true });
    db.run(`CREATE TABLE something_else (id TEXT PRIMARY KEY)`);
    db.close();

    expect(statusFor(dbPath).setup.hasUsers).toBeNull();
  });
});
