import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRestoreFlags } from "@/commands/backup-options.js";
import { type RestoreDeps, runRestore } from "@/commands/restore.js";
import { publicStage, readLocalRestoreStage } from "@/commands/restore-support.js";
import { DEFAULT_DEPS } from "@/service.js";
import { saveRestoreStage, stagedBackupFromRecord } from "@/services/backup-staging.js";
import {
  backup,
  databaseValue,
  fixture,
  put,
  rewriteArchive,
  root,
  setupBackupFixtures,
} from "@/services/backups/__tests__/fixtures.js";
import { rollbackInstanceRestore } from "@/services/backups/index.js";
import type { InstancePaths } from "@/services/backups/types.js";

setupBackupFixtures();
const stages: string[] = [];
afterEach(async () => {
  for (const id of stages.splice(0)) {
    try {
      await stagedBackupFromRecord(readLocalRestoreStage(id, true)).cleanup();
    } catch {}
  }
});
function dependencies(source: InstancePaths, logs: string[], errors: string[]): RestoreDeps {
  rmSync(join(source.dataDir, "update", "pending.json"), { force: true });
  return {
    source: () => source,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    isTTY: false,
    service: DEFAULT_DEPS({
      platform: "linux",
      home: root,
      uid: process.getuid?.() ?? 0,
      servicePath: process.execPath,
      argv1: "",
      configDir: dirname(source.configPath as string),
      env: {},
      which: () => null,
    }),
    manager: {
      query: () => {
        throw new Error("Preparation must not query or control the manager");
      },
      stop: () => {
        throw new Error("Unexpected stop");
      },
      start: () => {
        throw new Error("Unexpected start");
      },
    },
  };
}
describe("native offline restore preparation", () => {
  it("prefills inspection from archived locations and configuration, with compatibility for older archives", async () => {
    const source = fixture("archive-source");
    const current = fixture("current-machine");
    const archive = await backup(source);
    const older = await rewriteArchive(archive, async (payload) => {
      const entry = payload["manifest.json"];
      const manifest = JSON.parse(typeof entry === "string" ? entry : await (entry as Blob).text());
      delete manifest.sourcePaths;
      payload["manifest.json"] = JSON.stringify(manifest);
    });
    for (const [path, configPath] of [
      [archive, source.configPath],
      [older, current.configPath],
    ]) {
      const logs: string[] = [];
      const errors: string[] = [];
      const opts = parseRestoreFlags([path as string, "--inspect", "--json"], (line) => errors.push(line));
      expect(await runRestore(opts ?? {}, dependencies(current, logs, errors)), errors.join("\n")).toBe(0);
      expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
        destination: { databasePath: source.databasePath, dataDir: source.dataDir, configPath },
        choices: { configOverrides: { host: "0.0.0.0", port: "3080", baseUrl: "http://source:3080" } },
      });
      expect(logs.join("\n")).not.toContain("BETTER_AUTH_SECRET");
      expect(logs.join("\n")).not.toContain("UNSUPPORTED_SECRET");
    }
  });
  it("validates and stores fixed destination choices without touching a running target", async () => {
    const source = fixture("source");
    const destination = fixture("destination", "original");
    rmSync(join(destination.dataDir, "update", "pending.json"), { force: true });
    const auth = new Database(source.databasePath);
    auth.exec(
      "CREATE TABLE account(id TEXT PRIMARY KEY, accountId TEXT, providerId TEXT, userId TEXT, password TEXT, createdAt TEXT, updatedAt TEXT); CREATE TABLE session(userId TEXT);",
    );
    auth.close();
    const archive = await backup(source, "archive-password");
    const passwordFile = join(root, "password");
    put(passwordFile, "archive-password\n");
    const temporaryFile = join(root, "temporary");
    put(temporaryFile, "temporary-admin-password\n");
    const logs: string[] = [];
    const errors: string[] = [];
    const opts = parseRestoreFlags(
      [
        archive,
        "--prepare",
        "--json",
        "--no-start",
        "--mode",
        "migration",
        "--password-file",
        passwordFile,
        "--recover-admin",
        "admin-id",
        "--temporary-password-file",
        temporaryFile,
        "--data-dir",
        destination.dataDir,
        "--database-path",
        destination.databasePath,
        "--config-dir",
        dirname(destination.configPath as string),
        "--base-url",
        "https://restored.example",
      ],
      (line) => errors.push(line),
    );
    expect(opts).not.toBeNull();
    const preparedCode = await runRestore(opts ?? {}, dependencies(source, logs, errors));
    expect(preparedCode, errors.join("\n")).toBe(0);
    const result = JSON.parse(logs[0] ?? "{}");
    stages.push(result.id);
    expect(result).toMatchObject({
      prepared: true,
      destination,
      choices: { mode: "migration", configOverrides: { baseUrl: "https://restored.example" } },
      recoveryUserId: "admin-id",
    });
    expect(databaseValue(destination.databasePath)).toBe("original");
    expect(readFileSync(destination.configPath as string, "utf8")).toContain("/old/absolute");
    expect(JSON.stringify(publicStage(readLocalRestoreStage(result.id)))).not.toContain("temporary-admin-password");
    const conflict = { ...dependencies(source, logs, errors) };
    expect(
      await runRestore(
        { staged: result.id, databasePath: join(root, "wrong.db"), json: true, yes: true, start: false },
        conflict,
      ),
    ).toBe(1);
    expect(databaseValue(destination.databasePath)).toBe("original");
    const appliedLogs: string[] = [];
    const applyDeps = {
      ...dependencies(source, appliedLogs, errors),
      manager: {
        query: () => ({
          installed: false,
          definitionPath: null,
          state: "stopped",
          pid: null,
          enabled: false,
          linger: null,
          paneSafety: "keeps",
          detail: "",
        }),
        stop: () => ({ code: 0, err: "" }),
        start: () => ({ code: 0, err: "" }),
      },
      checkDatabaseUsers: () => {},
      probePort: () => false,
    } satisfies RestoreDeps;
    expect(await runRestore({ staged: result.id, json: true, yes: true, start: false }, applyDeps)).toBe(0);
    const applied = JSON.parse(appliedLogs[0] ?? "{}");
    expect(applied.destination).toEqual(destination);
    expect(databaseValue(destination.databasePath)).toBe("source");
    await rollbackInstanceRestore(applied.journalPath);
  });
  it("honors a start:false stored at preparation when the apply names no start choice", async () => {
    // The whole point of storing the choice with the transaction: `--prepare
    // --no-start` and a later bare `--staged <id>` must agree. The manager
    // here THROWS on start, so a broken thread-through (defaulting to boot)
    // fails the run, while the correct no-boot path leaves it pending-boot.
    const source = fixture("start-stored-source");
    const destination = fixture("start-stored-destination", "original");
    rmSync(join(destination.dataDir, "update", "pending.json"), { force: true });
    const logs: string[] = [];
    const errors: string[] = [];
    expect(
      await runRestore(
        {
          archive: await backup(source),
          prepare: true,
          json: true,
          start: false,
          dataDir: destination.dataDir,
          databasePath: destination.databasePath,
          configDir: dirname(destination.configPath as string),
        },
        dependencies(source, logs, errors),
      ),
      errors.join("\n"),
    ).toBe(0);
    const result = JSON.parse(logs[0] ?? "{}");
    stages.push(result.id);
    expect(readLocalRestoreStage(result.id).choices?.start).toBe(false);
    const applyDeps = {
      ...dependencies(source, logs, errors),
      manager: {
        query: () =>
          ({
            installed: false,
            definitionPath: null,
            state: "stopped",
            pid: null,
            enabled: false,
            linger: null,
            paneSafety: "keeps",
            detail: "",
          }) as const,
        stop: () => ({ code: 0, err: "" }),
        start: () => {
          throw new Error("boot was attempted despite the stored start:false");
        },
      },
      startDetached: () => {
        throw new Error("detached boot attempted despite the stored start:false");
      },
      checkDatabaseUsers: () => {},
      probePort: () => false,
    } satisfies RestoreDeps;
    logs.length = 0;
    // No `start` in the opts — it must read the stored false.
    const code = await runRestore({ staged: result.id, json: true, yes: true }, applyDeps);
    expect(code, errors.join("\n")).toBe(0);
    const applied = JSON.parse(logs[0] ?? "{}");
    expect(applied.status).toBe("pending-boot");
    expect(applied.started).toBe(false);
    await rollbackInstanceRestore(applied.journalPath);
  });
  it("discards a protected expired stage and refuses conflicting preparation flags", async () => {
    const source = fixture("source");
    const logs: string[] = [];
    const errors: string[] = [];
    const preparedCode = await runRestore(
      { archive: await backup(source), prepare: true, json: true, start: false },
      dependencies(source, logs, errors),
    );
    expect(preparedCode, errors.join("\n")).toBe(0);
    const result = JSON.parse(logs[0] ?? "{}");
    stages.push(result.id);
    const record = readLocalRestoreStage(result.id);
    record.expiresAt = Date.now() - 1;
    saveRestoreStage(record);
    logs.length = 0;
    expect(await runRestore({ discardStaged: result.id, json: true }, dependencies(source, logs, errors))).toBe(0);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({ id: result.id, discarded: true });
    expect(existsSync(record.stage.dir)).toBe(false);
    expect(parseRestoreFlags(["archive", "--prepare", "--yes"], () => {})).toBeNull();
    expect(parseRestoreFlags(["--discard-staged", result.id, "--force"], () => {})).toBeNull();
  });
});
