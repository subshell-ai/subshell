import { expect, test } from "bun:test";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { clearLock, type DaemonLock, lockPath, readLock, writeLock } from "../lock.js";
import { newHome } from "../test-preload.js";

/**
 * `daemon.lock` mechanics (fix wave 1 + task-16 polish): the file is the
 * local-liveness signal `status` reads, so its ownership semantics matter —
 * a terminating daemon must never delete the lock a surviving twin wrote into
 * the same home, and the file must carry the 0600 convention of everything
 * under the agent home.
 */

function lockFor(pid: number): DaemonLock {
  const stamp = new Date().toISOString();
  return { pid, startedAt: stamp, nodeId: "lock-test-node", lastTickAt: stamp };
}

test("writeLock: file lands 0600 even though the default umask would give 644", () => {
  newHome();
  writeLock(lockFor(process.pid));
  expect(statSync(lockPath()).mode & 0o077).toBe(0o000);
});

test("writeLock: re-tightens a pre-existing lock left group/world-readable", () => {
  newHome();
  writeLock(lockFor(process.pid));
  // Simulate an older agent (or a widened umask) having written the file at 644.
  writeFileSync(lockPath(), "stale\n");
  chmodSync(lockPath(), 0o644);
  writeLock(lockFor(process.pid)); // the next heartbeat tick
  expect(statSync(lockPath()).mode & 0o077).toBe(0o000);
  expect(readLock()?.pid).toBe(process.pid);
});

test("clearLock: deletes only the caller's own lock (dual-daemon same-home)", () => {
  newHome();
  const A = 100_001;
  const B = 100_002;

  writeLock(lockFor(A));
  clearLock(B); // a DIFFERENT daemon's exit must not clear our lock
  expect(existsSync(lockPath())).toBe(true);

  writeLock(lockFor(B)); // B takes over the shared home (last writer wins)
  clearLock(A); // A unwinds later — the survivor's lock stays
  expect(existsSync(lockPath())).toBe(true);
  expect(readLock()?.pid).toBe(B);

  clearLock(B); // the owner itself: gone
  expect(existsSync(lockPath())).toBe(false);
});

test("clearLock: corrupt or absent locks are left alone and never a liveness signal", () => {
  newHome();
  clearLock(process.pid); // absent → no throw, no-op
  writeFileSync(lockPath(), "{ not json");
  clearLock(process.pid); // unparseable → ownership unprovable → untouched
  expect(existsSync(lockPath())).toBe(true);
  expect(readLock()).toBeNull(); // status still reads this as OFFLINE
});
