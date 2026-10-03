import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Cooperating server and restore processes hold this for their whole operation. */
export interface InstanceLock {
  pid: number;
  kind: "server" | "restore" | "backup" | "state-write";
}

export function readInstanceLock(path: string): InstanceLock | null {
  if (!existsSync(path)) return null;
  let lock: InstanceLock;
  try {
    lock = JSON.parse(readFileSync(path, "utf8")) as InstanceLock;
  } catch {
    throw new Error("The instance lock is unreadable. Verify the server is stopped before removing it.");
  }
  if (
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 0 ||
    !["server", "restore", "backup", "state-write"].includes(lock.kind)
  ) {
    throw new Error("The instance lock is invalid. Verify the server is stopped before removing it.");
  }
  try {
    process.kill(lock.pid, 0);
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return null;
  }
}

export function acquireInstanceLock(path: string, kind: InstanceLock["kind"]): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // SQLite supplies an OS-backed lock that is released even if the process
  // crashes. A stale PID file is never used to decide exclusive ownership.
  const mutex = new Database(`${path}.sqlite`, { create: true });
  chmodSync(`${path}.sqlite`, 0o600);
  try {
    mutex.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    writeFileSync(path, JSON.stringify({ pid: process.pid, kind }), { mode: 0o600 });
  } catch {
    mutex.close();
    throw new Error("Instance state is already in use by another server or restore process.");
  }
  let released = false;
  return () => {
    if (released) return;
    try {
      const lock = JSON.parse(readFileSync(path, "utf8")) as InstanceLock;
      if (lock.pid !== process.pid || lock.kind !== kind) throw new Error("Instance lock ownership changed.");
      rmSync(path);
      mutex.exec("ROLLBACK");
    } finally {
      // The sqlite handle is closed even when the ownership check or the file
      // read throws. A leaked handle keeps BEGIN IMMEDIATE conflicting with
      // this process's OWN dead transaction for the life of the process, so
      // one unreadable lock file used to poison every later state write.
      // Nobody else could have taken the OS lock while this handle held it,
      // so closing on a failed release cannot step on a live owner.
      mutex.close();
      released = true;
    }
  };
}
