import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentHome } from "./config.js";

/**
 * `<agentHome>/daemon.lock` — the local-liveness file `mote-agent run` keeps
 * and `mote-agent status` reads (fix wave 1, spec §7 posture).
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
  /** PID of the `mote-agent run` that owns the lock. */
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
  return join(agentHome(), "daemon.lock");
}

/**
 * Persist (create or refresh) the lock. Creates the home dir if missing.
 * @throws whatever fs throws — callers treat the lock as best-effort and log.
 */
export function writeLock(lock: DaemonLock): void {
  mkdirSync(agentHome(), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`);
}

/** Remove the lock; absence counts as success (`force`). */
export function clearLock(): void {
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
