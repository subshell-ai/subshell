import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { collectStatus } from "@/commands/status.js";

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

  it("reports a temp database it can actually read", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-db-real-"));
    const dbPath = join(dir, "subshell.db");
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE user_meta (id TEXT PRIMARY KEY)");
    db.run("INSERT INTO user_meta (id) VALUES ('u1')");
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
