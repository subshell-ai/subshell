import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientHome } from "./config.js";

/**
 * `<clientHome>/daemon.lock` — the local-liveness file `subshell run` keeps
 * and `subshell status` reads (fix wave 1, spec §7 posture).
 *
 * Why this exists: `status` used to probe with a live WS connect
 * unconditionally, and that was DESTRUCTIVE — the control-plane registry is
 * newest-wins, so the probe supersede-kicked (terminal 4409) any remote-run
 * agent for this node. `status` now answers ONLINE/OFFLINE from this lock when
 * a local daemon is alive and dials the plane only when explicitly asked to
 * (`--probe`). The lock is best-effort observability, not a security object —
 * nothing authoritative may be derived from it.
 *
 * Synchronous fs on purpose: the clear must complete BEFORE `process.exit`
 * (an async unlink would be cut off), and the write is one small file per
 * heartbeat tick (15 s default), so a sync rewrite is cheaper than the
 * bookkeeping to avoid one.
 */

/** Contents of the daemon lock file. */
export interface DaemonLock {
  /** PID of the `subshell run` that owns the lock. */
  pid: number;
  /** ISO timestamp of when that daemon started. */
  startedAt: string;
  /** The node it registered as — a lock for a different node is never ours. */
  nodeId: string;
  /** ISO timestamp of the newest heartbeat tick — `status` exposes its age as `daemonAgeMs`. */
  lastTickAt: string;
}

/** Path to the lock file for the current agent home. */
export function lockPath(): string {
  return join(clientHome(), "daemon.lock");
}

/**
 * Persist (create or refresh) the lock. Creates the home dir if missing.
 * Mode 0600 is explicit (project convention for anything under the agent
 * home): the 0700 dir guards the path, the mode guards the file once any
 * tool widens the dir — and it matches the config/identity stores next door.
 * @throws whatever fs throws — callers treat the lock as best-effort and log.
 */
export function writeLock(lock: DaemonLock): void {
  mkdirSync(clientHome(), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  // Same re-tightening pass config.saveConfig does: write mode is umask-masked
  // AND applies only on create, so this also pulls a lock left at 644 by an
  // older agent down to 600 on the next heartbeat tick.
  if ((statSync(lockPath()).mode & 0o077) !== 0) chmodSync(lockPath(), 0o600);
}

/**
 * Remove the lock, but ONLY while `ownerPid` still owns it: read the current
 * lock and delete only when its pid matches. Dual-daemon same-home: two
 * `subshell run` processes share one `daemon.lock` (last writer wins), and
 * the first one to exit must not delete the survivor's lock — a missing lock
 * would read as OFFLINE while a daemon is happily running. A lock we cannot
 * parse or that names another pid is therefore left alone; `readLock` treats
 * a corrupt lock as absent, so a stale corrupt lock never fakes liveness.
 * @param ownerPid - pid of the daemon claiming ownership (usually `process.pid`)
 */
export function clearLock(ownerPid: number): void {
  if (readLock()?.pid !== ownerPid) return;
  rmSync(lockPath(), { force: true });
}

/**
 * Read + validate the lock.
 * @returns the lock, or null when it is absent, unparseable, or malformed
 * (a corrupt lock is not a liveness signal; the caller treats it as absent)
 */
export function readLock(): DaemonLock | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(raw) as Partial<DaemonLock> | null;
    if (
      typeof o?.pid !== "number" ||
      !Number.isInteger(o.pid) ||
      typeof o.nodeId !== "string" ||
      typeof o.startedAt !== "string" ||
      typeof o.lastTickAt !== "string"
    ) {
      return null;
    }
    return { pid: o.pid, startedAt: o.startedAt, nodeId: o.nodeId, lastTickAt: o.lastTickAt };
  } catch {
    return null;
  }
}

/**
 * True when `pid` still exists on this host. Signal 0 performs the kernel's
 * existence+permission check without delivering anything: EPERM means the
 * process is there but not ours, ESRCH (and EINVAL, e.g. a pid beyond
 * `pid_max`) means it is gone.
 * @param pid - candidate process id
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}
