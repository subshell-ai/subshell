import { Database } from "bun:sqlite";
import { afterEach, beforeEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInstanceBackup, stageInstanceBackup } from "../archive.js";
import type { InstancePaths, StagedInstanceBackup } from "../types.js";
export let root: string;
const stages: StagedInstanceBackup[] = [];
export const secret = "a-valid-authentication-secret-1234567890";

export function put(path: string, value: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}

export function fixture(name: string, marker = name): InstancePaths {
  const dataDir = join(root, name, "data");
  const databasePath = join(root, name, "external-db", "custom.db");
  const configPath = join(root, name, "config", "config.env");
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE kysely_migration(name TEXT PRIMARY KEY, timestamp TEXT);
    CREATE TABLE user(id TEXT PRIMARY KEY, email TEXT, name TEXT, password TEXT);
    CREATE TABLE user_meta(user_id TEXT PRIMARY KEY, role TEXT);
    CREATE TABLE plugin_state(plugin_id TEXT PRIMARY KEY, enabled INTEGER, updated_at TEXT);
    CREATE TABLE sample(value TEXT);`);
  db.query("INSERT INTO kysely_migration VALUES (?, ?)").run("0001-init", new Date().toISOString());
  db.query("INSERT INTO user VALUES (?, ?, ?, ?)").run(
    "admin-id",
    "admin@example.com",
    marker,
    "private-password-hash",
  );
  db.query("INSERT INTO user_meta VALUES (?, ?)").run("admin-id", "admin");
  db.query("INSERT INTO sample VALUES (?)").run(marker);
  db.close();
  put(
    configPath,
    `BETTER_AUTH_SECRET=${secret}\nSERVER_PORT=3080\nHOST=0.0.0.0\nAPP_BASE_URL=http://source:3080\nDATABASE_PATH=/old/absolute/path.db\nSUBSHELL_EMERGENCY_PASSWORD=must-not-back-up\nUNSUPPORTED_SECRET=not-backed-up\n`,
  );
  put(join(dataDir, "node-signing.json"), JSON.stringify({ privateKey: `${marker}-node-key` }));
  put(join(dataDir, "node-encryption.json"), JSON.stringify({ privateKey: `${marker}-encryption-key` }));
  put(join(dataDir, "identities", "sess-one.json"), JSON.stringify({ privateJwk: `${marker}-channel-key` }));
  put(join(dataDir, "peers.json"), JSON.stringify({ peer: "public-key" }));
  put(join(dataDir, "plugins", ".seeded"), "completed");
  put(join(dataDir, "plugins", "net", "package.json"), JSON.stringify({ subshell: { id: "net", type: "network" } }));
  put(join(dataDir, "plugins", "net", "dist", "index.js"), "export default () => ({})");
  put(join(dataDir, "plugins-state", "net", "secrets", "token"), `${marker}-network-token`);
  put(
    join(dataDir, "plugins-state", "net", "network.json"),
    JSON.stringify({ published: true, port: 3080, addresses: ["https://old"], settings: { hostname: "host" } }),
  );
  put(join(dataDir, "logs", "server.log"), `${marker}-server-log\n`);
  put(join(dataDir, "subshells", "one.log"), `${marker}-pane-log\n`);
  for (const excluded of [
    "backups/prior.db",
    "backup-staging/upload.tar.gz",
    "mcp/launch.json",
    "node-artifacts/binary",
    "uploads/project.txt",
    "projects/source.txt",
    "update/pending.json",
  ]) {
    put(join(dataDir, excluded), "EXCLUDED");
  }
  return { dataDir, databasePath, configPath };
}

export function databaseValue(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT value FROM sample").get() as { value: string }).value;
  } finally {
    db.close();
  }
}

export async function backup(source: InstancePaths, password?: string): Promise<string> {
  const path = join(root, `backup-${Math.random()}.tar.gz`);
  await createInstanceBackup({ source, destinationPath: path, password });
  return path;
}

export async function stage(path: string, password?: string): Promise<StagedInstanceBackup> {
  const result = await stageInstanceBackup(path, password, join(root, "staging"));
  stages.push(result);
  return result;
}

export async function rewriteArchive(
  path: string,
  mutate: (payload: Record<string, Blob | string>) => Promise<void> | void,
): Promise<string> {
  const payload: Record<string, Blob | string> = Object.fromEntries(
    await new Bun.Archive(await Bun.file(path).bytes()).files(),
  );
  await mutate(payload);
  const target = join(root, `modified-${Math.random()}.tar.gz`);
  await Bun.Archive.write(target, payload, { compress: "gzip" });
  return target;
}

export function setupBackupFixtures(): void {
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "subshell-backup-engine-test-"));
    chmodSync(root, 0o700);
  });
  afterEach(async () => {
    for (const staged of stages.splice(0)) await staged.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
}
