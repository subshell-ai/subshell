import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { listLocalBackups } from "../backup-catalog.js";
import { databaseValue, fixture, put, setupBackupFixtures, stage } from "../backups/__tests__/fixtures.js";
import { createUpdateBackup } from "../update-backup.js";
import { revertUpdate } from "../update-transaction.js";

setupBackupFixtures();
test("upgrade backups are full archives with matching private rollback checkpoints and retention", async () => {
  const source = fixture("update-source", "old");
  rmSync(join(source.dataDir, "update", "pending.json"), { force: true });
  let released = 0;
  const input = {
    source,
    effectiveConfig: {},
    keep: 1,
    capture: () => () => {
      released++;
    },
  };
  const first = await createUpdateBackup(input);
  expect(first).not.toBeNull();
  if (!first) throw Error("Missing backup");
  expect(first.path.endsWith(".tar.gz")).toBe(true);
  expect(statSync(first.rollbackDatabase).mode & 0o777).toBe(0o600);
  const inspected = await stage(first.path);
  expect(inspected.legacyDatabaseOnly).toBe(false);
  expect(inspected.manifest.entries.some((entry) => entry.path === "config/config.env")).toBe(true);
  expect(inspected.manifest.entries.some((entry) => entry.path.startsWith("data/plugins"))).toBe(true);
  expect(databaseValue(first.rollbackDatabase)).toBe(databaseValue(inspected.databasePath));
  const db = new Database(source.databasePath);
  db.exec("UPDATE sample SET value='new'");
  db.close();
  const binary = join(source.dataDir, "test-binary");
  put(binary, "new binary");
  put(`${binary}.previous`, "old binary");
  revertUpdate(
    {
      from: "1.7.0",
      to: "1.8.0",
      binary,
      previousBinary: `${binary}.previous`,
      backup: first.rollbackDatabase,
      archiveBackup: first.path,
      origin: "cli",
      forced: false,
      startedAt: new Date().toISOString(),
    },
    Error("migration failure"),
    { dir: join(source.dataDir, "update"), databasePath: source.databasePath, probe: () => true },
  );
  expect(readFileSync(binary, "utf8")).toBe("old binary");
  rmSync(join(source.dataDir, "update", "failed.json"), { force: true });
  expect(databaseValue(source.databasePath)).toBe("old");
  const second = await createUpdateBackup(input);
  expect(second).not.toBeNull();
  expect(existsSync(first.path)).toBe(false);
  expect(existsSync(first.rollbackDatabase)).toBe(false);
  expect((await listLocalBackups(source.dataDir)).map((file) => file.legacyDatabaseOnly)).toEqual([false]);
  expect(readFileSync(source.configPath as string, "utf8")).toContain("BETTER_AUTH_SECRET");
  expect(released).toBe(2);
});
