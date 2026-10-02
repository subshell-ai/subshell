import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackup } from "@/commands/backup.js";
import { parseBackupFlags } from "@/commands/backup-options.js";
import { listLocalBackups } from "../backup-catalog.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("lists local upgrade snapshots and archives newest first without following links or capturing state", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "backup-catalog-"));
  roots.push(root);
  expect(await listLocalBackups(root)).toEqual([]);
  const dir = join(root, "backups");
  mkdirSync(dir, { mode: 0o700 });
  const old = "subshell-v0.9.0-20260101-000000.db";
  const newer = "subshell-v0.10.0-20260102-000000.db";
  const archive = "subshell-instance-v1.8.0.tar.gz.enc";
  for (const name of [old, newer, archive, "other.txt"]) writeFileSync(join(dir, name), "fixture", { mode: 0o600 });
  utimesSync(join(dir, old), new Date("2026-02-01"), new Date("2026-02-01"));
  utimesSync(join(dir, archive), new Date("2026-01-03"), new Date("2026-01-03"));
  symlinkSync(join(dir, old), join(dir, "subshell-v1.0.0-20260104-000000.db"));
  mkdirSync(join(dir, "directory.tar.gz"));
  const files = await listLocalBackups(root);
  expect(files.map((file) => file.name)).toEqual([archive, newer, old]);
  expect(files[0]).toMatchObject({ encrypted: true, legacyDatabaseOnly: false });
  expect(files[1]).toMatchObject({
    serverVersion: "0.10.0",
    createdAt: "2026-01-02T00:00:00.000Z",
    legacyDatabaseOnly: true,
  });
  const logs: string[] = [];
  expect(
    await runBackup(
      { list: true, json: true },
      {
        source: () => ({ dataDir: root, databasePath: join(root, "missing.db") }),
        log: (line) => logs.push(line),
        error: () => {},
        isTTY: false,
        capture: () => {
          throw Error("Listing must not capture or mutate");
        },
      },
    ),
  ).toBe(0);
  expect(JSON.parse(logs[0] ?? "{}").backups).toEqual(files);
  for (const args of [
    ["--list", "--encrypt"],
    ["--list", "--database-only"],
    ["--list", "--output", "x"],
  ])
    expect(parseBackupFlags(args, () => {})).toBeNull();
});
