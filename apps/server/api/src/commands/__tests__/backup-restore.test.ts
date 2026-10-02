import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runBackup } from "@/commands/backup.js";
import { parseBackupFlags, parseRestoreFlags } from "@/commands/backup-options.js";
import { readPasswordFile } from "@/commands/backup-password.js";
import { type RestoreDeps, runRestore } from "@/commands/restore.js";
import { publicStage, readLocalRestoreStage } from "@/commands/restore-support.js";
import { assertNoDatabaseUsers, liveRestorePanes, restoreChildEnv } from "@/commands/restore-system.js";
import { DEFAULT_DEPS, type ServiceState } from "@/service.js";
import { stagedBackupFromRecord } from "@/services/backup-staging.js";
import { backup, databaseValue, fixture, root, setupBackupFixtures } from "@/services/backups/__tests__/fixtures.js";
import {
  finalizeInstanceRestoreSync,
  rollbackInstanceRestore,
  rollbackInstanceRestoreSync,
  stageInstanceBackup,
} from "@/services/backups/index.js";
import type { InstancePaths } from "@/services/backups/types.js";
import { backupDatabase } from "@/services/db-backup.js";
import { acquireInstanceLock, readInstanceLock } from "@/services/instance-state-lock.js";

setupBackupFixtures();
let logs: string[];
let errors: string[];
beforeEach(() => {
  logs = [];
  errors = [];
});

function manager(installed = false) {
  let state = "stopped";
  const calls: string[] = [];
  const service: ServiceState = {
    installed,
    definitionPath: null,
    state: "stopped",
    pid: null,
    enabled: false,
    linger: null,
    paneSafety: "keeps",
    detail: "",
  };
  return {
    calls,
    query: () => ({ ...service, state: state as ServiceState["state"] }),
    stop: () => {
      calls.push("stop");
      state = "stopped";
      return { code: 0, err: "" };
    },
    start: () => {
      calls.push("start");
      state = "running";
      return { code: 0, err: "" };
    },
  };
}
function dependencies(source: InstancePaths, installed = false): RestoreDeps {
  rmSync(join(source.dataDir, "update", "pending.json"), { force: true });
  const configDir = dirname(source.configPath as string);
  return {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    isTTY: false,
    source: () => source,
    service: DEFAULT_DEPS({
      platform: "linux",
      home: root,
      uid: process.getuid?.() ?? 0,
      servicePath: process.execPath,
      argv1: "",
      configDir,
      env: {},
      which: () => null,
    }),
    manager: manager(installed),
    servicePaths: () => source,
    panes: async () => [],
    checkDatabaseUsers: () => {},
    probePort: () => false,
    waitMs: 100,
  };
}

describe("backup and restore command policy", () => {
  test("native service destination preflight rejects alternate full and legacy paths before control, including no-start", async () => {
    const source = fixture("native-service", "original");
    const archive = await backup(fixture("native-source", "restored"));
    for (const legacy of [false, true]) {
      const input = legacy ? join(root, "native-legacy.db") : archive;
      if (legacy) await Bun.write(input, Bun.file(fixture("native-legacy-source", "legacy").databasePath));
      const deps = dependencies(source, true);
      const controls = deps.manager as ReturnType<typeof manager>;
      const other = fixture(`native-other-${legacy}`, "other-original");
      rmSync(join(other.dataDir, "update", "pending.json"), { force: true });
      const prepare = {
        archive: input,
        prepare: true,
        json: true,
        start: false,
        configDir: legacy ? dirname(source.configPath as string) : dirname(other.configPath as string),
        databasePath: other.databasePath,
        dataDir: other.dataDir,
      };
      expect(await runRestore(prepare, deps), errors.join("\n")).toBe(0);
      const prepared = JSON.parse(logs.pop() as string);
      expect(prepared.transactionId).toBe(prepared.id);
      expect(prepared.journalPath).toBe(join(prepare.configDir, "restore-journal.json"));
      expect(await runRestore({ staged: prepared.id, nativePreflight: true, json: true }, deps)).toBe(1);
      expect(await runRestore({ staged: prepared.id, native: true, start: false, yes: true, json: true }, deps)).toBe(
        1,
      );
      expect(controls.calls).toEqual([]);
      expect(databaseValue(other.databasePath)).toBe("other-original");
      expect(databaseValue(source.databasePath)).toBe("original");
      expect(existsSync(prepared.journalPath)).toBe(false);
      expect(errors.join("\n")).toContain("installed service cannot boot");
      await stagedBackupFromRecord(readLocalRestoreStage(prepared.id)).cleanup();
    }
  });
  test("compatible native no-start service paths are retained for a later boot and stage UUID receipts", async () => {
    const source = fixture("native-compatible", "original");
    const deps = dependencies(source, true);
    const controls = deps.manager as ReturnType<typeof manager>;
    expect(
      await runRestore(
        {
          archive: await backup(fixture("native-compatible-source", "restored")),
          prepare: true,
          json: true,
          start: false,
        },
        deps,
      ),
    ).toBe(0);
    const prepared = JSON.parse(logs.pop() as string);
    const record = readLocalRestoreStage(prepared.id);
    expect(publicStage(record).destination).toEqual(source);
    expect(await runRestore({ staged: prepared.id, nativePreflight: true, json: true }, deps)).toBe(0);
    expect(controls.calls).toEqual([]);
    expect(
      await runRestore({ staged: prepared.id, native: true, json: true, yes: true, start: false }, deps),
      errors.join("\n"),
    ).toBe(0);
    const applied = JSON.parse(logs.pop() as string);
    expect(applied.transactionId).toBe(prepared.id);
    expect(applied.status).toBe("pending-boot");
    expect(applied.destination).toEqual(source);
    expect(controls.calls).toEqual(["stop"]);
    const journal = JSON.parse(await Bun.file(applied.journalPath).text());
    expect(journal.transactionId).toBe(prepared.id);
    expect(journal.destination).toEqual(source);
    finalizeInstanceRestoreSync(applied.journalPath);
    const receipt = JSON.parse(await Bun.file(join(dirname(applied.journalPath), "restore-result.json")).text());
    expect(receipt).toMatchObject({ transactionId: prepared.id, outcome: "completed" });
  });
  test("native seams accept only readonly preflight and prepared staged applications", () => {
    const id = crypto.randomUUID();
    expect(parseRestoreFlags(["--staged", id, "--native-preflight", "--json"], () => {})).toMatchObject({
      staged: id,
      nativePreflight: true,
    });
    for (const flags of [
      ["archive", "--native"],
      ["--staged", id, "--native-preflight", "--yes"],
      ["--staged", id, "--native-preflight", "--no-start"],
      ["--staged", id, "--native", "--inspect"],
    ])
      expect(parseRestoreFlags(flags, () => {})).toBeNull();
  });
  test("strict flags reject ambiguity and plaintext-password switches", () => {
    for (const args of [
      ["--password", "secret"],
      ["--output=a", "--output=b"],
      ["--database-only", "--encrypt"],
    ])
      expect(parseBackupFlags(args, () => {})).toBeNull();
    for (const args of [
      ["a", "b"],
      ["a", "--staged", crypto.randomUUID()],
      ["a", "--start", "--no-start"],
      ["a", "--mode", "typo"],
      ["a", "--inspect", "--yes"],
      ["a", "--password-file", "-", "--recover-admin", "a", "--temporary-password-file", "-"],
    ])
      expect(parseRestoreFlags(args, () => {})).toBeNull();
    expect(parseRestoreFlags(["--list-staged", "--json"], () => {})).toEqual({ listStaged: true, json: true });
  });

  test("password files require owner-only permissions and a single line", () => {
    const path = join(root, "password");
    writeFileSync(path, "private value\n", { mode: 0o600 });
    expect(readPasswordFile(path)).toBe("private value");
    chmodSync(path, 0o644);
    expect(() => readPasswordFile(path)).toThrow("permissions");
    chmodSync(path, 0o600);
    writeFileSync(path, "first\nsecond\n");
    expect(() => readPasswordFile(path)).toThrow("one nonempty line");
  });

  test("default full capture includes keys, no retention sweep, and optional encryption defaults off", async () => {
    const source = fixture("source", "captured");
    let defaultAnswer: boolean | undefined;
    const file = join(root, "full.tar.gz");
    expect(
      await runBackup(
        { output: file },
        {
          log: (line) => logs.push(line),
          error: (line) => errors.push(line),
          source: () => source,
          effectiveConfig: () => ({}),
          capture: () => () => {},
          isTTY: true,
          confirm: async (_question, def) => {
            defaultAnswer = def;
            return def;
          },
        },
      ),
    ).toBe(0);
    expect(defaultAnswer).toBe(false);
    expect(existsSync(join(source.dataDir, "backups", "prior.db"))).toBe(true);
    expect(await runRestore({ archive: file, inspect: true, json: true }, dependencies(source))).toBe(0);
    expect(
      JSON.parse(logs.at(-1) as string).manifest.entries.some(
        (entry: { path: string }) => entry.path === "data/plugins-state/net/secrets/token",
      ),
    ).toBe(true);
    expect(logs.join("\n")).not.toContain("captured-network-token");
  });

  test("JSON encryption never prompts; protected transport is required", async () => {
    const source = fixture("source");
    expect(
      await runBackup(
        { encrypt: true, json: true, output: join(root, "no.tar.gz") },
        {
          log: (line) => logs.push(line),
          error: (line) => errors.push(line),
          source: () => source,
          isTTY: true,
          secretPrompt: async () => {
            throw new Error("must not prompt");
          },
        },
      ),
    ).toBe(1);
    expect(existsSync(join(root, "no.tar.gz"))).toBe(false);
    expect(errors.join("\n")).toContain("--password-file");
  });

  test("bad archive password and address overrides refuse before stopping a service", async () => {
    const source = fixture("source");
    const path = await backup(source, "correct-password");
    const password = join(root, "pw");
    writeFileSync(password, "wrong-password", { mode: 0o600 });
    const deps = dependencies(source, true);
    expect(await runRestore({ archive: path, passwordFile: password, yes: true, start: false }, deps)).toBe(1);
    expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
    const plain = await backup(source);
    expect(await runRestore({ archive: plain, yes: true, configOverrides: { port: "wrong" } }, deps)).toBe(1);
    expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
  });

  test("headless replacement refuses without --yes and pane consent is separate", async () => {
    const source = fixture("source");
    const path = await backup(source);
    const deps = dependencies(source, true);
    expect(await runRestore({ archive: path, start: false }, deps)).toBe(1);
    expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
    deps.panes = async () => [{ id: "remote-pane", socket: null, nodeId: "node-one" }];
    expect(await runRestore({ archive: path, yes: true, start: false }, deps)).toBe(1);
    expect(errors.join("\n")).toContain("--yes confirms replacement only");
    expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
  });

  test("no-start creates a recoverable pending-boot transaction without starting", async () => {
    const old = fixture("old", "old");
    const archive = await backup(fixture("new", "new"));
    const deps = dependencies(old, true);
    expect(await runRestore({ archive, yes: true, start: false, json: true }, deps)).toBe(0);
    const output = JSON.parse(logs.at(-1) as string);
    expect(output).toMatchObject({
      status: "pending-boot",
      started: false,
      mode: "same-machine",
      legacyDatabaseOnly: false,
    });
    expect(databaseValue(old.databasePath)).toBe("new");
    expect((deps.manager as ReturnType<typeof manager>).calls).toEqual(["stop"]);
    await rollbackInstanceRestore(output.journalPath);
    expect(databaseValue(old.databasePath)).toBe("old");
  });

  test("default start waits for its receipt and releases locks before starting", async () => {
    const old = fixture("old", "old");
    const archive = await backup(fixture("new", "new"));
    const deps = dependencies(old, true);
    (deps.manager as NonNullable<RestoreDeps["manager"]>).start = () => {
      const release = acquireInstanceLock(join(dirname(old.configPath as string), "instance-state.lock"), "server");
      release();
      finalizeInstanceRestoreSync(join(dirname(old.configPath as string), "restore-journal.json"));
      return { code: 0, err: "" };
    };
    let calls = 0;
    deps.probePort = () => ++calls > 1;
    expect(await runRestore({ archive, yes: true, json: true }, deps)).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({ status: "completed", started: true });
  });

  test("legacy installed-service start refuses changed destinations before stop; no-start and configured paths are valid", async () => {
    const captured = fixture("captured", "legacy");
    const snapshot = await backupDatabase({
      reason: "manual",
      databasePath: captured.databasePath,
      dir: join(root, "snapshots"),
      keep: 0,
    });
    if (!snapshot) throw new Error("Legacy snapshot fixture was not created.");
    const original = fixture("original", "original");
    const deps = dependencies(original, true);
    const otherDatabase = join(root, "alternate", "restored.db");
    for (const choices of [{ databasePath: otherDatabase }, { dataDir: join(root, "alternate-data") }]) {
      expect(await runRestore({ archive: snapshot.path, ...choices, yes: true, json: true }, deps)).toBe(1);
      expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
      expect(databaseValue(original.databasePath)).toBe("original");
      expect(existsSync(otherDatabase)).toBe(false);
      expect(existsSync(join(dirname(original.configPath as string), "restore-journal.json"))).toBe(false);
    }
    expect(errors.join("\n")).toContain("database-only restore does not change config.env");
    expect(
      await runRestore(
        { archive: snapshot.path, databasePath: otherDatabase, yes: true, start: false, json: true },
        deps,
      ),
    ).toBe(0);
    expect(databaseValue(otherDatabase)).toBe("legacy");
    expect(databaseValue(original.databasePath)).toBe("original");
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({
      started: false,
      status: "pending-boot",
      legacyDatabaseOnly: true,
    });
    await rollbackInstanceRestore(join(dirname(original.configPath as string), "restore-journal.json"));

    const configured = fixture("configured", "before");
    const configuredDeps = dependencies(configured, true);
    let serving = false;
    (configuredDeps.manager as NonNullable<RestoreDeps["manager"]>).start = () => {
      serving = true;
      finalizeInstanceRestoreSync(join(dirname(configured.configPath as string), "restore-journal.json"));
      return { code: 0, err: "" };
    };
    configuredDeps.probePort = () => serving;
    expect(
      await runRestore(
        {
          archive: snapshot.path,
          databasePath: configured.databasePath,
          dataDir: configured.dataDir,
          yes: true,
          json: true,
        },
        configuredDeps,
      ),
    ).toBe(0);
    expect(databaseValue(configured.databasePath)).toBe("legacy");
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({
      started: true,
      status: "completed",
      legacyDatabaseOnly: true,
    });
  });

  test("invoking another config home never authorizes stopping or starting the global installed service", async () => {
    const original = fixture("original", "original");
    const installed = fixture("installed", "installed");
    const archive = await backup(fixture("archive", "restored"));
    const deps = dependencies(original, true);
    delete deps.servicePaths;
    const serviceHome = join(root, "service-home");
    const installedConfig = join(serviceHome, ".config", "subshell-server");
    deps.service.home = serviceHome;
    deps.manager = manager(true);
    const query = deps.manager.query;
    deps.manager.query = () => ({
      ...query(),
      definitionPath: join(serviceHome, ".config", "systemd", "user", "subshell-server.service"),
    });
    deps.service.runCmd = (argv) => ({
      code: 0,
      out: argv.includes("show-environment")
        ? `HOME=${serviceHome}\n`
        : `WorkingDirectory=${installedConfig}\nEnvironmentFiles=${installedConfig}/config.env (ignore_errors=no)\nEnvironment=\n`,
      err: "",
    });
    deps.service.readFile = () =>
      `DATABASE_PATH=${installed.databasePath}\nSUBSHELL_SERVER_DATA_DIR=${installed.dataDir}\nSERVER_PORT=3080\n`;
    expect(await runRestore({ archive, yes: true, json: true }, deps)).toBe(1);
    expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
    expect(databaseValue(original.databasePath)).toBe("original");
    expect(databaseValue(installed.databasePath)).toBe("installed");
    expect(await runRestore({ archive, yes: true, start: false, json: true }, deps)).toBe(0);
    expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
    expect(databaseValue(original.databasePath)).toBe("restored");
    expect(databaseValue(installed.databasePath)).toBe("installed");
    await rollbackInstanceRestore(join(dirname(original.configPath as string), "restore-journal.json"));

    deps.service.runCmd = () => ({ code: 1, out: "", err: "unavailable" });
    expect(await runRestore({ archive, yes: true, start: false, json: true }, deps)).toBe(1);
    expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
    expect(databaseValue(original.databasePath)).toBe("original");
  });

  test("a running installed service must own the proven instance's live server mutex before stop", async () => {
    const original = fixture("running-original", "original");
    const archive = await backup(fixture("running-archive", "restored"));
    const deps = dependencies(original, true);
    const controlled = deps.manager as ReturnType<typeof manager>;
    const stoppedQuery = controlled.query;
    let running = true;
    let reportedPid = process.pid;
    controlled.query = () => ({ ...stoppedQuery(), state: running ? "running" : "stopped", pid: reportedPid });
    expect(await runRestore({ archive, yes: true, start: false, json: true }, deps)).toBe(1);
    expect(controlled.calls).toEqual([]);
    expect(databaseValue(original.databasePath)).toBe("original");
    const lockPath = join(dirname(original.configPath as string), "instance-state.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, kind: "server" }));
    new Database(`${lockPath}.sqlite`, { create: true }).close();
    expect(await runRestore({ archive, yes: true, start: false, json: true }, deps)).toBe(1);
    expect(controlled.calls).toEqual([]);
    expect(databaseValue(original.databasePath)).toBe("original");
    const release = acquireInstanceLock(lockPath, "server");
    try {
      reportedPid = process.pid + 1;
      expect(await runRestore({ archive, yes: true, start: false, json: true }, deps)).toBe(1);
      expect(controlled.calls).toEqual([]);
      expect(databaseValue(original.databasePath)).toBe("original");
      reportedPid = process.pid;
      const stop = controlled.stop;
      controlled.stop = () => {
        release();
        running = false;
        return stop();
      };
      expect(await runRestore({ archive, yes: true, start: false, json: true }, deps)).toBe(0);
      expect(controlled.calls).toEqual(["stop"]);
      expect(databaseValue(original.databasePath)).toBe("restored");
    } finally {
      release();
    }
  });

  test("cleanup and output failures roll back offline without stopping an unrelated installed service", async () => {
    const archive = await backup(fixture("failure-archive", "restored"));
    const unrelated = fixture("failure-unrelated", "unrelated");
    for (const failure of ["cleanup", "output"]) {
      const original = fixture(`failure-${failure}`, "original");
      const deps = dependencies(original, true);
      deps.servicePaths = () => unrelated;
      if (failure === "cleanup") {
        deps.stageArchive = async (path, password) => {
          const staged = await stageInstanceBackup(path, password);
          const cleanup = staged.cleanup;
          let calls = 0;
          staged.cleanup = async () => {
            if (++calls === 1) throw new Error("stage cleanup unavailable");
            await cleanup();
          };
          return staged;
        };
      } else
        deps.log = () => {
          throw new Error("output unavailable");
        };
      expect(await runRestore({ archive, yes: true, start: false, json: true }, deps)).toBe(1);
      expect((deps.manager as ReturnType<typeof manager>).calls).toEqual([]);
      expect(databaseValue(original.databasePath)).toBe("original");
      expect(databaseValue(unrelated.databasePath)).toBe("unrelated");
      const configDir = dirname(original.configPath as string);
      expect(existsSync(join(configDir, "restore-journal.json"))).toBe(false);
      expect(readInstanceLock(join(configDir, "instance-state.lock"))).toBeNull();
      expect(readInstanceLock(join(configDir, "backup-capture.lock"))).toBeNull();
    }
  });

  test("a rolled-back boot receipt is failure even when the old service is answering", async () => {
    const old = fixture("old", "old");
    const archive = await backup(fixture("new", "new"));
    const deps = dependencies(old, true);
    let calls = 0;
    deps.probePort = () => ++calls > 1;
    (deps.manager as NonNullable<RestoreDeps["manager"]>).start = () => {
      rollbackInstanceRestoreSync(join(dirname(old.configPath as string), "restore-journal.json"));
      return { code: 0, err: "" };
    };
    expect(await runRestore({ archive, yes: true }, deps)).toBe(1);
    expect(databaseValue(old.databasePath)).toBe("old");
    expect(errors.join("\n")).toContain("failed during boot");
  });

  test("a still-running unmanaged instance refuses before replacement", async () => {
    const old = fixture("old", "old");
    const archive = await backup(fixture("new", "new"));
    const release = acquireInstanceLock(join(dirname(old.configPath as string), "instance-state.lock"), "server");
    try {
      expect(await runRestore({ archive, yes: true, start: false }, dependencies(old))).toBe(1);
    } finally {
      release();
    }
    expect(databaseValue(old.databasePath)).toBe("old");
    expect(errors.join("\n")).toContain("unmanaged");
  });

  test("fresh child environment removes old paths and secrets", () => {
    const source = fixture("source");
    const saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "must-not-inherit";
    try {
      const env = restoreChildEnv(dirname(source.configPath as string), source, false);
      expect(env.BETTER_AUTH_SECRET).toBeUndefined();
      expect(env.DATABASE_PATH).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  });

  test("an offline SQLite reader in a real process prevents inode replacement", async () => {
    const source = fixture("source");
    const helper = join(root, "reader.ts");
    writeFileSync(
      helper,
      'import { Database } from "bun:sqlite"; const db=new Database(process.argv[2], {readonly:true}); db.query("SELECT 1 FROM sample").get(); console.log("ready"); setInterval(()=>{},1000);',
    );
    const reader = Bun.spawn({
      cmd: [process.execPath, helper, source.databasePath],
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "development" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const stream = reader.stdout.getReader();
      await stream.read();
      stream.releaseLock();
      expect(() => assertNoDatabaseUsers(source.databasePath)).toThrow(`process ${reader.pid}`);
    } finally {
      reader.kill();
      await reader.exited;
    }
  });

  test("CLI recovery changes only an existing staged administrator and hides the temporary password", async () => {
    const source = fixture("source", "new");
    const auth = new Database(source.databasePath);
    auth.exec(
      "CREATE TABLE account(id TEXT PRIMARY KEY, accountId TEXT, providerId TEXT, userId TEXT, password TEXT, createdAt TEXT, updatedAt TEXT); CREATE TABLE session(userId TEXT);",
    );
    auth.close();
    const archive = await backup(source);
    const old = fixture("old", "old");
    const deps = dependencies(old);
    deps.isTTY = true;
    let prompts = 0;
    deps.secretPrompt = async () => {
      prompts++;
      return "temporary-private-4T!";
    };
    expect(await runRestore({ archive, recoverAdmin: "admin-id", yes: true, start: false }, deps)).toBe(0);
    expect(prompts).toBe(2);
    const restored = new Database(old.databasePath, { readonly: true });
    try {
      expect(restored.query("SELECT user_id FROM backup_recovery").get()).toEqual({ user_id: "admin-id" });
      const password = restored.query("SELECT password FROM account WHERE userId='admin-id'").get() as {
        password: string;
      };
      expect(password.password).not.toBe("temporary-private-4T!");
    } finally {
      restored.close();
    }
    expect(logs.join("\n") + errors.join("\n")).not.toContain("temporary-private-4T!");
    await rollbackInstanceRestore(join(dirname(old.configPath as string), "restore-journal.json"));
  });

  test("real local tmux pane survives --yes refusal and is terminated only with --force", async () => {
    const source = fixture("source");
    const tmuxDir = join(root, "tmux");
    mkdirSync(tmuxDir, { mode: 0o700 });
    const oldTmp = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = tmuxDir;
    const id = crypto.randomUUID();
    const socket = `subshell-bk-${id.slice(0, 8)}`;
    try {
      const launched = Bun.spawnSync({
        cmd: ["tmux", "-L", socket, "new-session", "-d", "-s", id, "sleep 60"],
        env: { ...process.env, TMUX_TMPDIR: tmuxDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (launched.exitCode) throw new Error(`Could not launch isolated pane: ${launched.stderr.toString()}`);
      const db = new Database(source.databasePath);
      db.exec(
        "CREATE TABLE subshells(id TEXT PRIMARY KEY, tmux_socket TEXT, node_id TEXT, status TEXT, alive INTEGER, restart_on_exit INTEGER, next_restart_at TEXT);",
      );
      db.query("INSERT INTO subshells VALUES (?, ?, 'local', 'running', 1, 1, NULL)").run(id, socket);
      db.close();
      const probe = Bun.spawnSync({
        cmd: ["tmux", "-L", socket, "display-message", "-t", id, "-p", "#{pane_dead}"],
        env: { ...process.env, TMUX_TMPDIR: tmuxDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (probe.exitCode || probe.stdout.toString().trim() !== "0")
        throw new Error(`Pane readiness: ${probe.stdout.toString()} ${probe.stderr.toString()}`);
      expect(await liveRestorePanes(source.databasePath)).toHaveLength(1);
      const archive = await backup(source);
      const deps = dependencies(source);
      deps.panes = liveRestorePanes;
      expect(await runRestore({ archive, yes: true, start: false }, deps)).toBe(1);
      expect(await liveRestorePanes(source.databasePath)).toHaveLength(1);
      expect(await runRestore({ archive, yes: true, force: true, start: false }, deps)).toBe(0);
      expect(await liveRestorePanes(source.databasePath)).toHaveLength(0);
      const restored = new Database(source.databasePath, { readonly: true });
      try {
        expect(restored.query("SELECT status, alive, restart_on_exit FROM subshells").get()).toEqual({
          status: "terminated",
          alive: 0,
          restart_on_exit: 0,
        });
      } finally {
        restored.close();
      }
      await rollbackInstanceRestore(join(dirname(source.configPath as string), "restore-journal.json"));
    } finally {
      Bun.spawnSync({
        cmd: ["tmux", "-L", socket, "kill-server"],
        env: { ...process.env, TMUX_TMPDIR: tmuxDir },
        stdout: "ignore",
        stderr: "ignore",
      });
      if (oldTmp === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = oldTmp;
    }
  });
});
