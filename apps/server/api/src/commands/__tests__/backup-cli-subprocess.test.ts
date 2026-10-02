import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnvFile } from "@/config-env.js";
import type { StageRecord } from "@/services/backup-staging.js";
import { readInstanceRestoreResult } from "@/services/backups/index.js";
import { readInstanceLock } from "@/services/instance-state-lock.js";

const ENTRY = new URL("../../index.ts", import.meta.url).pathname;
const BUN = process.execPath;
const children: ReturnType<typeof Bun.spawn>[] = [];
const detached: number[] = [];
let root: string;
let isolatedEntry: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "subshell-backup-cli-process-"));
  isolatedEntry = join(root, "entry", "server.js");
  // Bundle the real entry with an embedded test shell. Its import.meta points
  // inside this temp tree, so concurrent SPA builds cannot remove its frontend.
  // Every server module, configuration layer, CLI and boot path remains real.
  const built = await Bun.build({
    entrypoints: [ENTRY],
    outdir: dirname(isolatedEntry),
    naming: "server.js",
    target: "bun",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [
      {
        name: "isolated-cli-static-shell",
        setup(builder) {
          builder.onLoad({ filter: /generated\/embedded-web\.ts$/ }, () => ({
            contents: `export const EMBEDDED=true; export const EMBEDDED_WEB={"index.html": "${Buffer.from("<!doctype html><title>CLI fixture</title>").toString("base64")}"};`,
            loader: "ts",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new Error(`Could not build isolated CLI entry: ${built.logs.join("\n")}`);
});
afterEach(async () => {
  // Discover every child we launched even when an assertion failed before
  // recording its PID. Every scanned path belongs to this test's temp root.
  for (const name of readdirSync(root)) {
    try {
      const lock = readInstanceLock(join(root, name, "instance-state.lock"));
      if (lock?.kind === "server") detached.push(lock.pid);
    } catch {
      /* extraction files are not config directories */
    }
  }
  for (const pid of detached.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  await Bun.sleep(100);
  rmSync(root, { recursive: true, force: true });
});

function environment(configDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    NODE_ENV: "development",
    SUBSHELL_SERVER_CONFIG_DIR: configDir,
    SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1",
    TMUX_TMPDIR: join(root, "tmux"),
  };
}

async function cli(args: string[], configDir: string, stdin?: string) {
  const child = Bun.spawn({
    cmd: [BUN, isolatedEntry, ...args],
    cwd: root,
    env: environment(configDir),
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  if (stdin !== undefined && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
function ok(result: { code: number; stdout: string; stderr: string }) {
  if (result.code !== 0) throw new Error(`CLI exited ${result.code}: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((ready) => socket.listen(0, "127.0.0.1", ready));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((ready) => socket.close(() => ready()));
  return port;
}
function configured(name: string, port: number) {
  const configDir = join(root, name);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const databasePath = join(configDir, "subshell.db");
  writeFileSync(
    join(configDir, "config.env"),
    `BETTER_AUTH_SECRET=${name.padEnd(40, "x")}\nDATABASE_PATH=${databasePath}\nSUBSHELL_SERVER_DATA_DIR=${configDir}\nSERVER_PORT=${port}\nHOST=127.0.0.1\nAPP_BASE_URL=http://localhost:${port}\nSUBSHELL_RELEASE_URL=\nSUBSHELL_PLUGIN_REGISTRY_URL=\n`,
    { mode: 0o600 },
  );
  return { configDir, databasePath };
}
async function boot(configDir: string, port: number) {
  const child = Bun.spawn({
    cmd: [BUN, isolatedEntry],
    cwd: root,
    env: environment(configDir),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const end = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`Server boot exited ${child.exitCode}: ${await stderr}\n${await stdout}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) break;
    } catch {}
    if (Date.now() > end) {
      child.kill();
      await child.exited;
      throw new Error(`Isolated server failed to boot in time: ${await stderr}\n${await stdout}`);
    }
    await Bun.sleep(50);
  }
  return child;
}

test("real entry: online full backup, encrypted stdin inspection, no-start replacement and fresh default start", async () => {
  const sourcePort = await freePort();
  const source = configured("source", sourcePort);
  const running = await boot(source.configDir, sourcePort);
  const db = new Database(source.databasePath);
  db.exec("CREATE TABLE cli_backup_probe(value TEXT); INSERT INTO cli_backup_probe VALUES ('captured live WAL');");
  db.close();
  writeFileSync(join(source.configDir, "logs", "backup-proof.log"), "captured-log");
  const password = "never-on-argv-9Q!";
  const pw = join(root, "password");
  writeFileSync(pw, `${password}\n`, { mode: 0o600 });
  const archive = join(root, "instance.enc");
  const capture = await cli(["backup", "--output", archive, "--password-file", pw, "--json"], source.configDir);
  const captured = ok(capture);
  expect(captured).toMatchObject({ path: archive, manifest: { format: "subshell-instance" } });
  expect(capture.stdout + capture.stderr).not.toContain(password);
  const inspected = ok(
    await cli(["restore", archive, "--password-file", "-", "--inspect", "--json"], source.configDir, `${password}\n`),
  );
  expect(inspected.legacyDatabaseOnly).toBe(false);
  expect(
    inspected.manifest.entries.some((entry: { path: string }) => entry.path === "data/logs/backup-proof.log"),
  ).toBe(true);
  expect(existsSync(join(root, "data"))).toBe(false);
  const refused = await cli(
    ["restore", archive, "--password-file", pw, "--yes", "--no-start", "--json"],
    source.configDir,
  );
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("unmanaged");
  expect(readInstanceLock(join(source.configDir, "instance-state.lock"))?.pid).toBe(running.pid);
  running.kill();
  await running.exited;

  const destinationPort = await freePort();
  const destination = configured("destination", destinationPort);
  const replaced = ok(
    await cli(
      [
        "restore",
        archive,
        "--password-file",
        pw,
        "--mode",
        "migration",
        "--data-dir",
        destination.configDir,
        "--database-path",
        destination.databasePath,
        "--config-dir",
        destination.configDir,
        "--port",
        String(destinationPort),
        "--base-url",
        `http://localhost:${destinationPort}`,
        "--yes",
        "--no-start",
        "--json",
      ],
      source.configDir,
    ),
  );
  expect(replaced).toMatchObject({ status: "pending-boot", started: false, mode: "migration" });
  const config = parseEnvFile(readFileSync(join(destination.configDir, "config.env"), "utf8"));
  expect(config.DATABASE_PATH).toBe(destination.databasePath);
  expect(config.BETTER_AUTH_SECRET).toBe("source".padEnd(40, "x"));
  const manual = await boot(destination.configDir, destinationPort);
  // HTTP serving begins before the final boot reconciliation commits restore.
  // Match this transaction's receipt rather than assuming readiness commits it.
  const receiptDeadline = Date.now() + 15_000;
  let receipt = readInstanceRestoreResult(replaced.journalPath);
  while (!receipt || receipt.transactionId !== replaced.transactionId || receipt.outcome !== "completed") {
    if (receipt && receipt.transactionId === replaced.transactionId && receipt.outcome === "rolled-back")
      throw new Error("Manual boot rolled back the restored transaction.");
    if (manual.exitCode !== null) throw new Error("Manual boot exited before completing restore.");
    if (Date.now() >= receiptDeadline) throw new Error("Manual boot did not complete its restore receipt in time.");
    await Bun.sleep(25);
    receipt = readInstanceRestoreResult(replaced.journalPath);
  }
  expect(receipt).toMatchObject({ transactionId: replaced.transactionId, outcome: "completed" });
  manual.kill();
  await manual.exited;

  // The target process environment is stale after apply: a fresh spawned server must load the new config.
  const started = ok(
    await cli(
      [
        "restore",
        archive,
        "--password-file",
        pw,
        "--port",
        String(destinationPort),
        "--base-url",
        `http://localhost:${destinationPort}`,
        "--yes",
        "--json",
      ],
      destination.configDir,
    ),
  );
  expect(started).toMatchObject({ started: true, status: "completed" });
  const pid = readInstanceLock(join(destination.configDir, "instance-state.lock"))?.pid;
  expect(pid).toBeDefined();
  if (pid) detached.push(pid);
  const restoredDb = new Database(destination.databasePath, { readonly: true });
  try {
    expect(restoredDb.query("SELECT value FROM cli_backup_probe").get()).toEqual({ value: "captured live WAL" });
  } finally {
    restoredDb.close();
  }
  // A different offline destination tries to bind an exclusive TCP port.
  // A failed serving boot must roll back every byte.
  const failedDestination = configured("failed-boot", await freePort());
  const occupied = createServer();
  await new Promise<void>((ready) => occupied.listen(0, "127.0.0.1", ready));
  const occupiedPort = (occupied.address() as { port: number }).port;
  let failed: Awaited<ReturnType<typeof cli>>;
  try {
    failed = await cli(
      ["restore", archive, "--password-file", pw, "--port", String(occupiedPort), "--yes", "--json"],
      failedDestination.configDir,
    );
  } finally {
    await new Promise<void>((ready) => occupied.close(() => ready()));
  }
  expect(failed.code).toBe(1);
  expect(parseEnvFile(readFileSync(join(failedDestination.configDir, "config.env"), "utf8")).BETTER_AUTH_SECRET).toBe(
    "failed-boot".padEnd(40, "x"),
  );
  expect(existsSync(failedDestination.databasePath)).toBe(false);
  expect(readInstanceRestoreResult(join(failedDestination.configDir, "restore-journal.json"))?.outcome).toBe(
    "rolled-back",
  );
}, 60_000);

test("real entry: legacy snapshots are explicit; inspection does not recover a pending destination journal", async () => {
  const source = configured("source", await freePort());
  const live = await boot(
    source.configDir,
    Number(parseEnvFile(readFileSync(join(source.configDir, "config.env"), "utf8")).SERVER_PORT),
  );
  const legacy = ok(await cli(["backup", "--database-only", "--json"], source.configDir));
  expect(legacy.legacyDatabaseOnly).toBe(true);
  const invalidJournal = join(source.configDir, "restore-journal.json");
  writeFileSync(invalidJournal, "invalid journal should never be read by inspect", { mode: 0o600 });
  const inspected = ok(await cli(["restore", legacy.path, "--inspect", "--json"], source.configDir));
  expect(inspected).toMatchObject({ legacyDatabaseOnly: true, manifest: { consistency: "legacy-database-only" } });
  expect(readFileSync(invalidJournal, "utf8")).toBe("invalid journal should never be read by inspect");
  rmSync(invalidJournal);
  live.kill();
  await live.exited;
}, 30_000);

test("real entry: prepared staging enumerates public metadata and applies only prepared choices", async () => {
  const source = configured("source", await freePort());
  const live = await boot(
    source.configDir,
    Number(parseEnvFile(readFileSync(join(source.configDir, "config.env"), "utf8")).SERVER_PORT),
  );
  const archive = ok(await cli(["backup", "--json"], source.configDir)).path as string;
  live.kill();
  await live.exited;
  const extracted = ok(await cli(["restore", archive, "--inspect", "--json"], source.configDir));
  // A genuine engine stage produced in a separate subprocess, without boot or an auth singleton.
  const helper = join(root, "prepare.ts");
  const stagingModule = new URL("../../services/backup-staging.ts", import.meta.url).pathname;
  writeFileSync(
    helper,
    `import {createRestoreStage,saveRestoreStage} from ${JSON.stringify(stagingModule)};\nconst row=await createRestoreStage(process.argv[2],"offline-admin");row.prepared=true;row.choices={mode:"migration",configOverrides:{host:"127.0.0.1"}};saveRestoreStage(row);console.log(JSON.stringify({id:row.id}));`,
  );
  const prepare = Bun.spawn({
    cmd: [BUN, helper, archive],
    cwd: root,
    env: environment(source.configDir),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(prepare);
  const id = JSON.parse(await new Response(prepare.stdout).text()).id as string;
  expect(await prepare.exited).toBe(0);
  const metadata = join(source.configDir, "backup-staging", id, "stage.json");
  const record = JSON.parse(readFileSync(metadata, "utf8")) as StageRecord;
  const listed = ok(await cli(["restore", "--list-staged", "--json"], source.configDir));
  expect(listed.stages).toHaveLength(1);
  expect(listed.stages[0]).toMatchObject({
    id,
    prepared: true,
    choices: { mode: "migration" },
    admins: extracted.admins,
  });
  expect(listed.stages[0].stage).toBeUndefined();
  record.prepared = false;
  writeFileSync(metadata, JSON.stringify(record));
  expect((await cli(["restore", "--staged", id, "--yes", "--no-start", "--json"], source.configDir)).code).toBe(1);
  record.prepared = true;
  writeFileSync(metadata, JSON.stringify(record));
  const restored = ok(await cli(["restore", "--staged", id, "--yes", "--no-start", "--json"], source.configDir));
  expect(restored).toMatchObject({ status: "pending-boot", mode: "migration" });
  expect(existsSync(dirname(metadata))).toBe(false);
}, 30_000);
