import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { beginBackupCapture, beginBackupStateWrite } from "@/services/backup-capture-lock.js";

// The lock file `beginBackupStateWrite` acquires, in the same per-test temp
// data dir the module resolves under IS_TEST.
const captureLock = () => join(SUBSHELL_SERVER_DATA_DIR, "backup-capture.lock");

describe("backup state-write capture lock", () => {
  it("nests host writes under one exclusion and excludes a concurrent capture", () => {
    const outer = beginBackupStateWrite();
    const inner = beginBackupStateWrite(); // a nested write shares the one lock
    expect(() => beginBackupCapture()).toThrow("already in use");
    inner();
    expect(() => beginBackupCapture()).toThrow("already in use"); // still held by `outer`
    outer();
    const capture = beginBackupCapture(); // fully released now
    expect(() => beginBackupStateWrite()).toThrow("already in use");
    capture();
    const again = beginBackupStateWrite();
    again();
  });

  it("recovers a later write when a release refuses on a lost lock file", () => {
    // The bug the ordering fix + finally-close exist to prevent: the lock file
    // removed out from under a holding server (a manual stale-lock cleanup, an
    // interrupted sibling). The release throws, and if the SQLite handle leaks
    // its BEGIN IMMEDIATE (measured: same-process connections conflict), EVERY
    // later writeConfigEnv / plugin install / key generation dies "already in
    // use" for the life of the process.
    const first = beginBackupStateWrite();
    rmSync(captureLock(), { force: true }); // the file this lock wrote is deleted
    expect(() => first()).toThrow();
    // A fresh write must succeed, not inherit the poisoned mutex.
    const second = beginBackupStateWrite();
    expect(() => second()).not.toThrow();
  });

  it("refuses a second capture while one is held and releases exactly once", () => {
    const a = beginBackupCapture();
    expect(() => beginBackupCapture()).toThrow("already in use");
    a();
    a(); // idempotent second release is a no-op, not a throw or double-decrement
    const b = beginBackupStateWrite();
    b();
  });
});
