import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkpointDatabase } from "../database.js";
import { assertInstanceRestoreDestination, readInstanceRestoreResult, recoverInstanceRestoreSync } from "../journal.js";
import {
  finalizeInstanceRestore,
  recoverInstanceRestore,
  restoreInstanceBackup,
  rollbackInstanceRestore,
} from "../transaction.js";

import { backup, databaseValue, fixture, put, root, setupBackupFixtures, stage } from "./fixtures.js";

setupBackupFixtures();

function crashWithHotRollbackJournal(path: string): void {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS spill(bytes BLOB)");
  db.close();
  const script = `${path}.crash.ts`;
  put(
    script,
    `import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(path)});
    db.exec("PRAGMA cache_size=5; BEGIN IMMEDIATE; UPDATE sample SET value='uncommitted-crash'");
    for (let index=0; index<200; index++) db.exec("INSERT INTO spill VALUES(zeroblob(4096))");
    process.kill(process.pid, "SIGKILL");`,
  );
  const child = Bun.spawnSync([process.execPath, script]);
  expect(child.exitCode).not.toBe(0);
  const journal = readFileSync(`${path}-journal`);
  expect(journal.length).toBeGreaterThan(512);
  // Cache spill synchronized the hot journal header before writing uncommitted pages into main.
  expect(journal.subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
}

describe("offline replacement transactions", () => {
  it("reserves a prepared stage UUID before replacement and refuses an already consumed receipt or invalid ID", async () => {
    const staged = await stage(await backup(fixture("reserved-source")));
    const destination = fixture("reserved-destination", "original");
    await expect(restoreInstanceBackup(staged, { destination, transactionId: "../../invalid" })).rejects.toThrow(
      "identifier",
    );
    expect(databaseValue(destination.databasePath)).toBe("original");
    const transactionId = crypto.randomUUID();
    const applied = await restoreInstanceBackup(staged, { destination, transactionId });
    expect(applied.transactionId).toBe(transactionId);
    await rollbackInstanceRestore(applied.journalPath);
    expect(readInstanceRestoreResult(applied.journalPath)).toMatchObject({ transactionId, outcome: "rolled-back" });
    await expect(restoreInstanceBackup(staged, { destination, transactionId })).rejects.toThrow("already consumed");
    expect(databaseValue(destination.databasePath)).toBe("original");
    expect(existsSync(applied.journalPath)).toBe(false);
  });
  it("refuses boot confirmation from a different database or full instance path", async () => {
    const staged = await stage(await backup(fixture("boot-source")));
    const destination = fixture("boot-destination");
    const applied = await restoreInstanceBackup(staged, { destination });
    expect(() => assertInstanceRestoreDestination(applied.journalPath, destination)).not.toThrow();
    expect(() =>
      assertInstanceRestoreDestination(applied.journalPath, { ...destination, databasePath: join(root, "other.db") }),
    ).toThrow("database");
    expect(() =>
      assertInstanceRestoreDestination(applied.journalPath, { ...destination, dataDir: join(root, "other-data") }),
    ).toThrow("paths");
    expect(() =>
      assertInstanceRestoreDestination(applied.journalPath, { ...destination, configPath: join(root, "other.env") }),
    ).toThrow("paths");
    expect(readInstanceRestoreResult(applied.journalPath)).toBeNull();
    await rollbackInstanceRestore(applied.journalPath);
  });

  it("rolls partial application back on error, including custom paths and original config", async () => {
    const staged = await stage(await backup(fixture("source")));
    const destination = fixture("destination", "original");
    await expect(
      restoreInstanceBackup(staged, {
        destination,
        afterReplace: (component) => {
          if (component === "config") throw new Error("injected failure");
        },
      }),
    ).rejects.toThrow("injected failure");
    expect(databaseValue(destination.databasePath)).toBe("original");
    expect(readFileSync(destination.configPath as string, "utf8")).toContain("/old/absolute");
    expect(readdirSync(dirname(destination.databasePath)).some((name) => name.includes("restore-"))).toBe(false);
  });

  it("recovers an abruptly exited partial transaction before configuration is read", async () => {
    const staged = await stage(await backup(fixture("source")));
    const destination = fixture("destination", "original");
    const script = join(root, "interrupt.ts");
    put(
      script,
      `import { restoreInstanceBackup } from ${JSON.stringify(resolve(import.meta.dir, "../transaction.ts"))};
      const stage = ${JSON.stringify({ ...staged, cleanup: undefined })};
      await restoreInstanceBackup({ ...stage, cleanup: async () => {} }, {
        destination: ${JSON.stringify(destination)}, afterReplace: (component) => { if (component === "config") process.exit(17); }
      });`,
    );
    const child = Bun.spawnSync([process.execPath, script]);
    expect(child.exitCode).toBe(17);
    expect(databaseValue(destination.databasePath)).toBe("source");
    const journal = join(dirname(destination.configPath as string), "restore-journal.json");
    expect(recoverInstanceRestoreSync(journal)).toBe("rolled-back");
    expect(databaseValue(destination.databasePath)).toBe("original");
    expect(readFileSync(destination.configPath as string, "utf8")).toContain("/old/absolute");
    expect(recoverInstanceRestoreSync(journal)).toBe("none");
  });

  it("keeps service config present across the atomic config preservation boundary", async () => {
    const staged = await stage(await backup(fixture("source")));
    const destination = fixture("destination", "original");
    const script = join(root, "interrupt-config-preservation.ts");
    put(
      script,
      `import { mock } from "bun:test";
      import { existsSync } from "node:fs";
      import * as fsPromises from "node:fs/promises";
      const originalFs = { ...fsPromises };
      const configPath = ${JSON.stringify(destination.configPath)};
      // Child-local interception interrupts the real engine immediately before its config rename.
      mock.module("node:fs/promises", () => ({ ...originalFs, rename: async (from, to) => {
        if (String(from).startsWith(configPath + ".restore-new-"))
          process.exit(existsSync(configPath) ? 17 : 18);
        return originalFs.rename(from, to);
      }}));
      const { restoreInstanceBackup } = await import(${JSON.stringify(resolve(import.meta.dir, "../transaction.ts"))});
      const stage = ${JSON.stringify({ ...staged, cleanup: undefined })};
      const destination = ${JSON.stringify(destination)};
      await restoreInstanceBackup({ ...stage, cleanup: async () => {} }, { destination });`,
    );
    const child = Bun.spawnSync([process.execPath, script]);
    expect(child.exitCode).toBe(17);
    const configPath = destination.configPath as string;
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("/old/absolute");
    const journal = join(dirname(configPath), "restore-journal.json");
    expect(recoverInstanceRestoreSync(journal)).toBe("rolled-back");
    expect(readFileSync(configPath, "utf8")).toContain("/old/absolute");
    expect(databaseValue(destination.databasePath)).toBe("original");
    expect(readdirSync(dirname(configPath)).some((name) => name.includes(".restore-old-"))).toBe(false);

    const transaction = await restoreInstanceBackup(staged, { destination });
    expect(readFileSync(configPath, "utf8")).toContain(`DATABASE_PATH=${destination.databasePath}`);
    const applied = JSON.parse(readFileSync(transaction.journalPath, "utf8"));
    const config = applied.replacements.find((item: { component: string }) => item.component === "config");
    expect(readFileSync(config.previous, "utf8")).toContain("/old/absolute");
    await rollbackInstanceRestore(transaction.journalPath);
    expect(readFileSync(configPath, "utf8")).toContain("/old/absolute");
    expect(existsSync(config.previous)).toBe(false);
  });

  it("recovers an original hot journal before preserving it and removes orphan journals before replacement", async () => {
    for (const missingMain of [false, true]) {
      const staged = await stage(await backup(fixture(`source-${missingMain}`, "RESTORED")));
      const destination = fixture(`destination-${missingMain}`, "ORIGINAL");
      crashWithHotRollbackJournal(destination.databasePath);
      if (missingMain) rmSync(destination.databasePath);
      const transaction = await restoreInstanceBackup(staged, { destination });
      expect(existsSync(`${destination.databasePath}-journal`)).toBe(false);
      expect(databaseValue(destination.databasePath)).toBe("RESTORED");
      if (missingMain) {
        await finalizeInstanceRestore(transaction.journalPath);
      } else {
        await rollbackInstanceRestore(transaction.journalPath);
        expect(databaseValue(destination.databasePath)).toBe("ORIGINAL");
      }
    }
  });

  it("removes a failed replacement's hot journal before restoring the preserved original", async () => {
    for (const missingMain of [false, true]) {
      const staged = await stage(await backup(fixture(`source-${missingMain}`, "RESTORED")));
      const destination = fixture(`destination-${missingMain}`, "ORIGINAL");
      const transaction = await restoreInstanceBackup(staged, { destination });
      crashWithHotRollbackJournal(destination.databasePath);
      if (missingMain) rmSync(destination.databasePath);
      await rollbackInstanceRestore(transaction.journalPath);
      expect(existsSync(`${destination.databasePath}-journal`)).toBe(false);
      expect(databaseValue(destination.databasePath)).toBe("ORIGINAL");
    }
  });

  it("refuses rollback-journal symlinks before recovery or orphan cleanup", async () => {
    for (const missingMain of [false, true]) {
      const destination = fixture(`destination-${missingMain}`, "ORIGINAL");
      const protectedFile = join(root, `protected-${missingMain}`);
      put(protectedFile, "protected-content");
      symlinkSync(protectedFile, `${destination.databasePath}-journal`);
      if (missingMain) rmSync(destination.databasePath);
      await expect(checkpointDatabase(destination.databasePath)).rejects.toThrow("symlink");
      expect(readFileSync(protectedFile, "utf8")).toBe("protected-content");
      expect(existsSync(`${destination.databasePath}-journal`)).toBe(true);
    }
  });

  it("refuses rollback sidecar symlinks before installing the preserved database", async () => {
    for (const missingMain of [false, true]) {
      const staged = await stage(await backup(fixture(`source-${missingMain}`, "RESTORED")));
      const destination = fixture(`destination-${missingMain}`, "ORIGINAL");
      const transaction = await restoreInstanceBackup(staged, { destination });
      const protectedFile = join(root, `protected-${missingMain}`);
      put(protectedFile, "protected-content");
      symlinkSync(protectedFile, `${destination.databasePath}-journal`);
      if (missingMain) rmSync(destination.databasePath);
      await expect(rollbackInstanceRestore(transaction.journalPath)).rejects.toThrow("symlink");
      expect(readFileSync(protectedFile, "utf8")).toBe("protected-content");
      expect(existsSync(`${destination.databasePath}-journal`)).toBe(true);
      rmSync(`${destination.databasePath}-journal`);
      if (!missingMain) expect(databaseValue(destination.databasePath)).toBe("RESTORED");
      await rollbackInstanceRestore(transaction.journalPath);
      expect(databaseValue(destination.databasePath)).toBe("ORIGINAL");
    }
  });

  it("failed boot rollback removes new WAL state and restores the old database", async () => {
    const staged = await stage(await backup(fixture("source")));
    const destination = fixture("destination", "original");
    const transaction = await restoreInstanceBackup(staged, { destination });
    const db = new Database(destination.databasePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.query("UPDATE sample SET value=?").run("failed-migration-boot");
    db.close();
    await rollbackInstanceRestore(transaction.journalPath);
    expect(existsSync(`${destination.databasePath}-wal`)).toBe(false);
    expect(databaseValue(destination.databasePath)).toBe("original");
    await rollbackInstanceRestore(transaction.journalPath);
  });

  it("permits intentional administrator recovery changes to the staged database", async () => {
    const staged = await stage(await backup(fixture("source")));
    const db = new Database(staged.databasePath);
    db.query("UPDATE user SET name = ?").run("recovered-admin");
    db.close();
    const destination = fixture("destination");
    const transaction = await restoreInstanceBackup(staged, { destination });
    const restored = new Database(destination.databasePath, { readonly: true });
    expect((restored.query("SELECT name FROM user").get() as { name: string }).name).toBe("recovered-admin");
    restored.close();
    await finalizeInstanceRestore(transaction.journalPath);
  });

  it("revalidates staged index schemas before session deletion and migration writes", async () => {
    for (const kind of ["expression", "partial"]) {
      const staged = await stage(await backup(fixture(`source-${kind}`)));
      const db = new Database(staged.databasePath);
      db.exec('CREATE TABLE "session"(id TEXT PRIMARY KEY); INSERT INTO "session" VALUES(\'human-login\')');
      db.exec(
        kind === "expression"
          ? "CREATE INDEX huge ON plugin_state(hex(zeroblob(4*1024*1024)), enabled)"
          : "CREATE INDEX huge ON plugin_state(enabled) WHERE length(hex(zeroblob(4*1024*1024))) > 0",
      );
      db.close();
      const size = statSync(staged.databasePath).size;
      const destination = fixture(`destination-${kind}`, "original");
      await expect(restoreInstanceBackup(staged, { destination, mode: "migration" })).rejects.toThrow(
        `${kind} indexes are refused`,
      );
      expect(statSync(staged.databasePath).size).toBe(size);
      const original = new Database(staged.databasePath, { readonly: true });
      expect(original.query('SELECT count(*) AS count FROM "session"').get()).toEqual({ count: 1 });
      expect(original.query("SELECT count(*) AS count FROM plugin_state").get()).toEqual({ count: 0 });
      original.close();
      expect(databaseValue(destination.databasePath)).toBe("original");
      expect(existsSync(join(dirname(destination.configPath as string), "restore-journal.json"))).toBe(false);
    }
  });

  it("migration disables network plugins and clears publication while preserving secrets", async () => {
    const staged = await stage(await backup(fixture("source")));
    const destination = fixture("destination");
    const transaction = await restoreInstanceBackup(staged, { destination, mode: "migration" });
    const state = JSON.parse(readFileSync(join(destination.dataDir, "plugins-state", "net", "network.json"), "utf8"));
    expect(state.published).toBe(false);
    expect(state.addresses).toEqual([]);
    expect(state.port).toBeNull();
    expect(state.settings).toEqual({ hostname: "host" });
    const db = new Database(destination.databasePath, { readonly: true });
    expect(db.query("SELECT enabled FROM plugin_state WHERE plugin_id='net'").get()).toEqual({ enabled: 0 });
    db.close();
    expect(readFileSync(join(destination.dataDir, "plugins-state", "net", "secrets", "token"), "utf8")).toBe(
      "source-network-token",
    );
    await finalizeInstanceRestore(transaction.journalPath);
  });

  it("caps migration network and package JSON independently of archive payload sizes", async () => {
    for (const component of ["network", "package"]) {
      const source = fixture(`source-${component}`);
      const oversized = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
      const path =
        component === "network"
          ? join(source.dataDir, "plugins-state", "net", "network.json")
          : join(source.dataDir, "plugins", "net", "package.json");
      put(path, oversized);
      const staged = await stage(await backup(source));
      const destination = fixture(`destination-${component}`, "original");
      await expect(restoreInstanceBackup(staged, { destination, mode: "migration" })).rejects.toThrow(
        "JSON metadata exceeds limit",
      );
      expect(databaseValue(destination.databasePath)).toBe("original");
      expect(existsSync(join(dirname(destination.configPath as string), "restore-journal.json"))).toBe(false);
    }
  });

  it("revokes human sessions in prepared full and legacy restores while preserving staged data and pane keys", async () => {
    for (const legacy of [false, true]) {
      const source = fixture(`source-${legacy}`);
      const db = new Database(source.databasePath);
      db.exec(
        'CREATE TABLE "session"(id TEXT PRIMARY KEY, user_id TEXT); CREATE TABLE apikey(id TEXT PRIMARY KEY, token TEXT); CREATE TABLE sessions(id TEXT PRIMARY KEY, api_key_id TEXT);',
      );
      db.query('INSERT INTO "session" VALUES(?,?)').run("human-login", "admin-id");
      db.query("INSERT INTO apikey VALUES(?,?)").run("pane-key", "pane-bearer-token");
      db.query("INSERT INTO sessions VALUES(?,?)").run("pane", "pane-key");
      db.close();
      const staged = await stage(legacy ? source.databasePath : await backup(source));
      const destination = fixture(`destination-${legacy}`);
      const transaction = await restoreInstanceBackup(staged, { destination });
      const restored = new Database(destination.databasePath, { readonly: true });
      expect(restored.query('SELECT count(*) AS count FROM "session"').get()).toEqual({ count: 0 });
      expect(restored.query("SELECT token FROM apikey").get()).toEqual({ token: "pane-bearer-token" });
      expect(restored.query("SELECT api_key_id FROM sessions").get()).toEqual({ api_key_id: "pane-key" });
      restored.close();
      const original = new Database(staged.databasePath, { readonly: true });
      expect(original.query('SELECT count(*) AS count FROM "session"').get()).toEqual({ count: 1 });
      original.close();
      await finalizeInstanceRestore(transaction.journalPath);
    }
  });

  it("refuses overlapping destinations and outstanding journals before changing any files", async () => {
    const staged = await stage(await backup(fixture("source")));
    const destination = fixture("destination", "original");
    await expect(
      restoreInstanceBackup(staged, { destination: { ...destination, configPath: destination.databasePath } }),
    ).rejects.toThrow("overlap");
    const transaction = await restoreInstanceBackup(staged, { destination });
    await expect(restoreInstanceBackup(staged, { destination })).rejects.toThrow();
    await rollbackInstanceRestore(transaction.journalPath);
    expect(databaseValue(destination.databasePath)).toBe("original");
  });

  it("cleans interrupted finalization and removes optional state absent from a full backup", async () => {
    const source = fixture("source");
    rmSync(join(source.dataDir, "identities"), { recursive: true });
    const staged = await stage(await backup(source));
    const destination = fixture("destination");
    const transaction = await restoreInstanceBackup(staged, { destination });
    expect(existsSync(join(destination.dataDir, "identities"))).toBe(false);
    const journal = JSON.parse(readFileSync(transaction.journalPath, "utf8"));
    journal.phase = "finalizing";
    put(transaction.journalPath, JSON.stringify(journal));
    expect(await recoverInstanceRestore(transaction.journalPath)).toBe("finalized");
    expect(databaseValue(destination.databasePath)).toBe("source");
    expect(existsSync(transaction.journalPath)).toBe(false);
    expect(readdirSync(destination.dataDir).some((name) => name.includes("restore-old-"))).toBe(false);
  });

  it("refuses destination and journal symlinks, including dangling journal links", async () => {
    const staged = await stage(await backup(fixture("source")));
    const destination = fixture("destination");
    const journal = join(dirname(destination.configPath as string), "restore-journal.json");
    symlinkSync(join(root, "missing-target"), journal);
    expect(() => recoverInstanceRestoreSync(journal)).toThrow("symlink");
    await expect(restoreInstanceBackup(staged, { destination })).rejects.toThrow("symlink");
    rmSync(journal);
    const link = join(root, "linked-db");
    symlinkSync(destination.databasePath, link);
    await expect(
      restoreInstanceBackup(staged, { destination: { ...destination, databasePath: link } }),
    ).rejects.toThrow("symlink");
  });
  it("records the transaction outcome so a serving rolled-back instance cannot look like a successful restore", async () => {
    const staged = await stage(await backup(fixture("source")));
    const destination = fixture("destination", "original");
    const failed = await restoreInstanceBackup(staged, { destination });
    expect(readInstanceRestoreResult(failed.journalPath)).toBeNull();
    await rollbackInstanceRestore(failed.journalPath);
    expect(readInstanceRestoreResult(failed.journalPath)).toMatchObject({
      transactionId: failed.transactionId,
      outcome: "rolled-back",
    });
    expect(existsSync(failed.journalPath)).toBe(false);
    const succeeded = await restoreInstanceBackup(staged, { destination });
    // An old receipt must not confirm a new transaction.
    expect(readInstanceRestoreResult(succeeded.journalPath)?.transactionId).not.toBe(succeeded.transactionId);
    await finalizeInstanceRestore(succeeded.journalPath);
    expect(readInstanceRestoreResult(succeeded.journalPath)).toMatchObject({
      transactionId: succeeded.transactionId,
      outcome: "completed",
    });
    expect(existsSync(succeeded.journalPath)).toBe(false);
    expect(databaseValue(destination.databasePath)).toBe("source");
  });
});
