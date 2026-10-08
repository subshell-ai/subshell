import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashPassword } from "better-auth/crypto";
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
async function boot(configDir: string, port: number, container = false) {
  const child = Bun.spawn({
    cmd: [BUN, isolatedEntry, ...(container ? ["container-supervisor"] : [])],
    cwd: root,
    env: { ...environment(configDir), ...(container ? { SUBSHELL_CONTAINER: "1" } : {}) },
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
  const legacy = { path: join(source.configDir, "backups", "subshell-v1.7.0-20260101-000000.db") };
  mkdirSync(dirname(legacy.path), { recursive: true, mode: 0o700 });
  const snapshotDb = new Database(source.databasePath, { readonly: true });
  snapshotDb.query("VACUUM INTO ?").run(legacy.path);
  snapshotDb.close();
  chmodSync(legacy.path, 0o600);
  expect((await cli(["backup", "--database-only", "--json"], source.configDir)).code).toBe(1);
  const invalidJournal = join(source.configDir, "restore-journal.json");
  writeFileSync(invalidJournal, "invalid journal should never be read by inspect", { mode: 0o600 });
  const inspected = ok(await cli(["restore", legacy.path, "--inspect", "--json"], source.configDir));
  expect(inspected).toMatchObject({ legacyDatabaseOnly: true, manifest: { consistency: "legacy-database-only" } });
  expect(readFileSync(invalidJournal, "utf8")).toBe("invalid journal should never be read by inspect");
  expect(ok(await cli(["backup", "--list", "--json"], source.configDir)).backups).toHaveLength(1);
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
  const beforePreflight = readFileSync(metadata, "utf8");
  const preflight = ok(
    await cli(["restore", "--staged", id, "--native-preflight", "--json", "--force"], source.configDir),
  );
  expect(preflight.compatible).toBe(true);
  expect(readFileSync(metadata, "utf8")).toBe(beforePreflight);
  record.prepared = false;
  writeFileSync(metadata, JSON.stringify(record));
  expect((await cli(["restore", "--staged", id, "--yes", "--no-start", "--json"], source.configDir)).code).toBe(1);
  record.prepared = true;
  writeFileSync(metadata, JSON.stringify(record));
  const restored = ok(await cli(["restore", "--staged", id, "--yes", "--no-start", "--json"], source.configDir));
  expect(restored).toMatchObject({ status: "pending-boot", mode: "migration" });
  expect(existsSync(dirname(metadata))).toBe(false);
}, 30_000);

test("real entry: available older upgrade snapshot restores and migrates before serving", async () => {
  const port = await freePort();
  const instance = configured("upgrade-snapshot", port);
  const initial = await boot(instance.configDir, port);
  initial.kill();
  await initial.exited;
  const originalConfig = readFileSync(join(instance.configDir, "config.env"), "utf8");
  const backupDir = join(instance.configDir, "backups");
  mkdirSync(backupDir, { mode: 0o700 });
  const snapshot = join(backupDir, "subshell-v1.7.0-20260101-000000.db");
  const db = new Database(instance.databasePath);
  // "Older" must be a valid LEDGER PREFIX: the newest registered migrations
  // are stripped (rows AND their DDL) so the snapshot ends where an install of
  // that era would; removing one from the middle while a later row stands
  // above it is exactly the non-contiguous history kysely refuses to boot.
  // WHY 0047+0048+0049 together: this era's three migrations are the tail of
  // the registered ledger, so the prefix runs contiguously through 0046 and
  // boot re-applies all three. Advancing LATEST_BACKUP_MIGRATION (0049) means
  // the strip set moves with it in the same commit.
  const migrationRows = db
    .query(
      "SELECT * FROM kysely_migration WHERE name IN ('0047-node-ssh-enabled','0048-ssh-launch-and-saved-hosts','0049-ssh-relay-identity') ORDER BY name",
    )
    .all() as { name: string; timestamp: string }[];
  db.exec(
    "ALTER TABLE nodes DROP COLUMN ssh_enabled_at; ALTER TABLE nodes DROP COLUMN ssh_enabled; DROP TABLE ssh_saved_hosts; ALTER TABLE subshells DROP COLUMN ssh; ALTER TABLE identities DROP COLUMN signing_public_key; ALTER TABLE nodes DROP COLUMN ssh_fingerprint; DELETE FROM kysely_migration WHERE name IN ('0047-node-ssh-enabled','0048-ssh-launch-and-saved-hosts','0049-ssh-relay-identity'); CREATE TABLE migration_restore_probe(value TEXT); INSERT INTO migration_restore_probe VALUES ('older snapshot');",
  );
  db.query("VACUUM INTO ?").run(snapshot);
  db.exec(
    "ALTER TABLE nodes ADD COLUMN ssh_enabled integer NOT NULL DEFAULT 0; ALTER TABLE nodes ADD COLUMN ssh_enabled_at text; CREATE TABLE ssh_saved_hosts(id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES user(id), destination TEXT NOT NULL, alias TEXT, node_id TEXT NOT NULL, saved_at TEXT, last_connect_at TEXT NOT NULL); ALTER TABLE subshells ADD COLUMN ssh text; ALTER TABLE identities ADD COLUMN signing_public_key text; ALTER TABLE nodes ADD COLUMN ssh_fingerprint text; UPDATE migration_restore_probe SET value='newer destination';",
  );
  for (const row of migrationRows)
    db.query("INSERT INTO kysely_migration(name,timestamp) VALUES (?,?)").run(row.name, row.timestamp);
  db.close();
  const catalog = ok(await cli(["backup", "--list", "--json"], instance.configDir));
  expect(catalog.backups).toHaveLength(1);
  expect(catalog.backups[0]).toMatchObject({ path: snapshot, legacyDatabaseOnly: true, serverVersion: "1.7.0" });
  const restored = ok(await cli(["restore", snapshot, "--yes", "--no-start", "--json"], instance.configDir));
  expect(restored).toMatchObject({ status: "pending-boot", legacyDatabaseOnly: true });
  const offline = new Database(instance.databasePath, { readonly: true });
  expect(
    offline
      .query(
        "SELECT name FROM kysely_migration WHERE name IN ('0047-node-ssh-enabled','0048-ssh-launch-and-saved-hosts','0049-ssh-relay-identity')",
      )
      .all(),
  ).toEqual([]);
  offline.close();
  const running = await boot(instance.configDir, port);
  const migrated = new Database(instance.databasePath, { readonly: true });
  expect(
    migrated
      .query(
        "SELECT name FROM kysely_migration WHERE name IN ('0047-node-ssh-enabled','0048-ssh-launch-and-saved-hosts','0049-ssh-relay-identity') ORDER BY name",
      )
      .all(),
  ).toEqual([
    { name: "0047-node-ssh-enabled" },
    { name: "0048-ssh-launch-and-saved-hosts" },
    { name: "0049-ssh-relay-identity" },
  ]);
  expect(migrated.query("SELECT value FROM migration_restore_probe").get()).toEqual({ value: "older snapshot" });
  expect(
    migrated
      .query("SELECT name FROM pragma_table_info('nodes') WHERE name IN ('ssh_enabled','ssh_enabled_at') ORDER BY name")
      .all(),
  ).toEqual([{ name: "ssh_enabled" }, { name: "ssh_enabled_at" }]);
  expect(migrated.query("SELECT name FROM sqlite_schema WHERE name='ssh_saved_hosts'").get()).toEqual({
    name: "ssh_saved_hosts",
  });
  expect(migrated.query("SELECT name FROM pragma_table_info('subshells') WHERE name='ssh'").get()).toEqual({
    name: "ssh",
  });
  expect(
    migrated.query("SELECT name FROM pragma_table_info('identities') WHERE name='signing_public_key'").get(),
  ).toEqual({ name: "signing_public_key" });
  expect(migrated.query("SELECT name FROM pragma_table_info('nodes') WHERE name='ssh_fingerprint'").get()).toEqual({
    name: "ssh_fingerprint",
  });
  migrated.close();
  expect(readFileSync(join(instance.configDir, "config.env"), "utf8")).toBe(originalConfig);
  const deadline = Date.now() + 15_000;
  while (readInstanceRestoreResult(restored.journalPath)?.outcome !== "completed") {
    if (running.exitCode !== null || Date.now() >= deadline)
      throw Error("Migrated restored server did not commit its boot receipt");
    await Bun.sleep(25);
  }
}, 30_000);

for (const container of [false, true])
  test(`real entry: confirmed HTTP restore works ${container ? "with a container supervisor" : "headlessly"} and revokes the old session`, async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const nextPort = await freePort();
    const restoredOrigin = `http://127.0.0.1:${nextPort}`;
    const source = configured("headless", port);
    const running = await boot(source.configDir, port, container);
    const originalServerPid = readInstanceLock(join(source.configDir, "instance-state.lock"))?.pid;
    const database = new Database(source.databasePath);
    const adminId = crypto.randomUUID();
    const now = new Date().toISOString();
    database
      .query("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)")
      .run(adminId, "Restore admin", "restore@example.test", now, now);
    database
      .query(
        "INSERT INTO account(id,issuer,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,'local:credential',?,'credential',?,?,?,?)",
      )
      .run(adminId, adminId, adminId, await hashPassword("headless-restore-password"), now, now);
    database.query("INSERT INTO user_meta(user_id,role) VALUES (?,'admin')").run(adminId);
    database.exec(
      "CREATE TABLE headless_restore_probe(value TEXT); INSERT INTO headless_restore_probe VALUES ('backup state');",
    );
    database.close();
    const signedIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email: "restore@example.test", password: "headless-restore-password" }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const headers = { Cookie: cookie, "Content-Type": "application/json", Origin: origin };
    const post = (path: string, body: unknown) =>
      fetch(`${origin}/api/admin/backups${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const archive = ok(await cli(["backup", "--json"], source.configDir)).path as string;
    const upload = new FormData();
    upload.append("archive", new File([readFileSync(archive)], "instance.tar.gz"));
    const inspected = await fetch(`${origin}/api/admin/backups/inspect`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
      body: upload,
    });
    expect(inspected.status).toBe(200);
    const stage = (await inspected.json()) as { id: string };
    expect(
      (
        await post(`/staged/${stage.id}`, {
          mode: "same-machine",
          start: true,
          configOverrides: { port: String(nextPort) },
        })
      ).status,
    ).toBe(200);
    expect(await (await post(`/staged/${stage.id}/preflight`, {})).json()).toEqual({ affectedSessions: 0 });
    const changed = new Database(source.databasePath);
    changed.exec("UPDATE headless_restore_probe SET value='newer state'");
    changed.close();
    expect((await post(`/staged/${stage.id}/apply`, { confirmed: false })).status).toBe(400);
    expect(running.exitCode).toBeNull();
    const applied = await post(`/staged/${stage.id}/apply`, { confirmed: true, interruptSessions: false });
    expect(applied.status).toBe(200);
    const job = (await applied.json()) as { id: string; port: number; priorPort: number };
    expect(job.port).toBe(nextPort);
    expect(job.priorPort).toBe(port);
    const directory = join(tmpdir(), `subshell-restore-jobs-${process.getuid?.() ?? "user"}`, job.id);
    try {
      const deadline = Date.now() + 15000;
      let phase = "restoring";
      while (Date.now() < deadline && phase === "restoring") {
        try {
          const response = await fetch(`${restoredOrigin}/api/restore-status/${job.id}`, {
            headers: { Origin: origin },
          });
          if (response.ok) {
            expect(response.headers.get("access-control-allow-origin")).toBe("*");
            phase = ((await response.json()) as { phase: string }).phase;
          }
        } catch {
          /* expected offline interval */
        }
        await Bun.sleep(100);
      }
      if (phase !== "completed")
        throw new Error(
          `Restore ${phase}: ${existsSync(join(directory, "error.log")) ? readFileSync(join(directory, "error.log"), "utf8") : "no diagnostics"}`,
        );
      expect(running.exitCode).toBe(container ? null : 0);
      expect(readInstanceLock(join(source.configDir, "instance-state.lock"))?.pid).not.toBe(originalServerPid);
      const restored = new Database(source.databasePath, { readonly: true });
      expect(restored.query("SELECT value FROM headless_restore_probe").get()).toEqual({ value: "backup state" });
      restored.close();
      expect(readInstanceRestoreResult(join(source.configDir, "restore-journal.json"))).toMatchObject({
        transactionId: stage.id,
        outcome: "completed",
      });
      expect((await fetch(`${restoredOrigin}/api/admin/backups/saved`, { headers })).status).toBe(401);
      expect((await fetch(`${restoredOrigin}/api/restore-status/${crypto.randomUUID()}`)).status).toBe(404);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
