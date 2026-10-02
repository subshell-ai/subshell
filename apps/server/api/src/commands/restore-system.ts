import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { TmuxRunner } from "@internal/pane-runtime";
import { configEnvAppliedKeys, parseEnvFile } from "@/config-env.js";
import { BACKUP_CONFIG_KEYS } from "@/services/backups/index.js";
import { inspectSqliteSchema, requireMetadataColumns } from "@/services/backups/metadata.js";
import type { InstancePaths } from "@/services/backups/types.js";
import { readInstanceLock } from "@/services/instance-state-lock.js";
import { containsPath } from "@/services/reset-guards.js";

export interface RestorePane {
  id: string;
  socket: string | null;
  nodeId: string;
}

/** A live PID file alone can be stale after PID reuse; the mutex must also be held. */
export function assertRunningRestoreServiceOwner(lockPath: string, pid: number | null): void {
  const owner = readInstanceLock(lockPath);
  const reason =
    "The running service does not own the proven instance's live server lock. Stop it explicitly and verify its loaded configuration before restoring.";
  if (!pid || owner?.kind !== "server" || owner.pid !== pid || !existsSync(`${lockPath}.sqlite`))
    throw new Error(reason);
  const mutex = new Database(`${lockPath}.sqlite`, { readwrite: true, create: false });
  try {
    let held = false;
    try {
      mutex.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
      mutex.exec("ROLLBACK");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
      held = true;
    }
    const latest = readInstanceLock(lockPath);
    if (!held || latest?.kind !== "server" || latest.pid !== pid) throw new Error(reason);
  } finally {
    mutex.close();
  }
}

/** Read intent through an independent readonly handle; never initialize app/auth state. */
export function readRestorePanes(databasePath: string): RestorePane[] {
  if (!existsSync(databasePath)) return [];
  const db = new Database(databasePath, { readonly: true });
  try {
    const schema = inspectSqliteSchema(db);
    const table = schema.has("subshells") ? "subshells" : schema.has("sessions") ? "sessions" : null;
    if (!table) return [];
    requireMetadataColumns(schema, table, ["id", "tmux_socket", "status"]);
    const columns = schema.get(table) as Set<string>;
    return db
      .query(
        `SELECT id, tmux_socket AS socket, ${columns.has("node_id") ? "node_id" : "'local'"} AS nodeId FROM ${table} WHERE status='running' ${columns.has("alive") ? "AND alive=1" : ""} LIMIT 50001`,
      )
      .all() as RestorePane[];
  } finally {
    db.close();
  }
}

/** Pane sockets are probed only for this instance's rows, never swept globally. */
export async function liveRestorePanes(databasePath: string): Promise<RestorePane[]> {
  const rows = readRestorePanes(databasePath);
  if (rows.length > 50000) throw new Error("Too many active pane records to inspect safely.");
  const tmux = new TmuxRunner();
  const live: RestorePane[] = [];
  for (const pane of rows) {
    if (pane.nodeId !== "local") {
      live.push(pane);
      continue;
    }
    if (!pane.socket) continue;
    if (!/^subshell-[A-Za-z0-9_-]+$/.test(pane.socket) || !/^[A-Za-z0-9_-]+$/.test(pane.id))
      throw new Error("Invalid local pane identity; verify this instance before restoring.");
    if (!Bun.which("tmux")) throw new Error("Cannot verify local pane liveness without tmux.");
    try {
      const result = await tmux.runAsync(["-L", pane.socket, "display-message", "-t", pane.id, "-p", "#{pane_dead}"], {
        env: { ...process.env } as Record<string, string>,
      });
      if (result.stdout.trim() !== "1") live.push(pane);
    } catch (error) {
      // Only an explicit absent server/session proves there is no pane. A
      // timeout, permission failure or another probe error refuses restore.
      if (
        !/no server running|error connecting.*(?:No such file|Connection refused)|can't find session|can't find pane/.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
    }
  }
  return live;
}

export function terminateRestorePanes(panes: RestorePane[]): void {
  for (const pane of panes) {
    if (pane.nodeId !== "local" || !pane.socket) continue;
    const result = Bun.spawnSync({
      cmd: ["tmux", "-L", pane.socket, "kill-session", "-t", pane.id],
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const detail = `${result.stdout.toString()}${result.stderr.toString()}`;
    if (result.exitCode !== 0 && !/no server running|error connecting|can't find session/.test(detail))
      throw new Error(`Could not stop local pane ${pane.id}; restore was not applied.`);
  }
}

/** Remote processes survive disconnect; old and restored rows must not claim they are attached. */
export function retireRestorePanes(databasePath: string, ids?: string[]): void {
  if (!existsSync(databasePath)) return;
  const db = new Database(databasePath);
  try {
    const schema = inspectSqliteSchema(db);
    const table = schema.has("subshells") ? "subshells" : schema.has("sessions") ? "sessions" : null;
    if (!table) return;
    const columns = schema.get(table) as Set<string>;
    const assignments = [
      "status='terminated'",
      columns.has("alive") ? "alive=0" : "",
      columns.has("restart_on_exit") ? "restart_on_exit=0" : "",
      columns.has("next_restart_at") ? "next_restart_at=NULL" : "",
    ]
      .filter(Boolean)
      .join(", ");
    db.transaction(() => {
      if (ids) for (const id of ids) db.query(`UPDATE ${table} SET ${assignments} WHERE id=?`).run(id);
      else db.exec(`UPDATE ${table} SET ${assignments} WHERE status='running'`);
    })();
  } finally {
    db.close();
  }
}

export function sharesRestoreState(a: InstancePaths, b: InstancePaths): boolean {
  return (
    resolve(a.databasePath) === resolve(b.databasePath) ||
    containsPath(a.dataDir, b.dataDir) ||
    containsPath(b.dataDir, a.dataDir) ||
    (!!a.configPath && !!b.configPath && resolve(a.configPath) === resolve(b.configPath))
  );
}

/** Detect even idle SQLite readers: unlinking their inode while open is unsafe. */
export function assertNoDatabaseUsers(path: string): void {
  if (!existsSync(path)) return;
  const target = statSync(path);
  if (process.platform === "linux") {
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)) {
      const procDir = join("/proc", pid);
      try {
        if (process.getuid && statSync(procDir).uid !== process.getuid()) continue;
        for (const fd of readdirSync(join(procDir, "fd"))) {
          try {
            const fdPath = join(procDir, "fd", fd);
            const file = statSync(fdPath);
            if (file.dev === target.dev && file.ino === target.ino)
              throw new Error(`Database is open in process ${pid}; stop that process before restoring.`);
          } catch (error) {
            if (!["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        }
      } catch (error) {
        // Linux can hide descriptors of unrelated non-dumpable processes even
        // from their OS owner. Cooperating instance locks and SQLite's busy
        // checkpoint remain mandatory; inspect every descriptor we can access.
        if (!["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    return;
  }
  const lsof = Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : null);
  if (!lsof) throw new Error("Cannot verify offline database users: install lsof and retry.");
  const result = Bun.spawnSync({
    cmd: [lsof, "-t", "--", resolve(path)],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const users = result.stdout
    .toString()
    .trim()
    .split(/\s+/)
    .filter((pid) => /^\d+$/.test(pid) && Number(pid) !== process.pid);
  if (users.length) throw new Error(`Database is open in process ${users.join(", ")}; stop it before restoring.`);
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error("Cannot verify offline database users.");
}

/** Fresh restored config wins over the invoking CLI's loaded/env snapshot. */
export function restoreChildEnv(
  configDir: string,
  destination: InstancePaths,
  legacy: boolean,
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of [...BACKUP_CONFIG_KEYS, ...configEnvAppliedKeys()]) delete env[key];
  for (const key of Object.keys(env))
    if (/^SUBSHELL_SUPERVISOR|^SUBSHELL_TEST_MODE$|^SUBSHELL_EMERGENCY_PASSWORD$/.test(key)) delete env[key];
  env.SUBSHELL_SERVER_CONFIG_DIR = configDir;
  if (legacy) {
    env.DATABASE_PATH = destination.databasePath;
    env.SUBSHELL_SERVER_DATA_DIR = destination.dataDir;
  }
  return env;
}

export function restoredListenPort(destination: InstancePaths, fallback: number): number {
  if (!destination.configPath || !existsSync(destination.configPath)) return fallback;
  const value = Number(parseEnvFile(readFileSync(destination.configPath, "utf8")).SERVER_PORT ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("Restored server port is invalid.");
  return value;
}

/** Reject any pending update state at both the known source and destination. */
export function assertNoUpdateTransaction(paths: InstancePaths[]): void {
  for (const path of paths)
    if (existsSync(join(path.dataDir, "update", "pending.json")))
      throw new Error("A server update transaction is pending; complete or roll it back before restoring.");
}
