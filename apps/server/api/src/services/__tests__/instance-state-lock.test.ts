import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, readInstanceLock } from "@/services/instance-state-lock.js";

const dirs: string[] = [];
const path = () => {
  const dir = mkdtempSync(join(tmpdir(), "subshell-state-lock-"));
  dirs.push(dir);
  return join(dir, "instance-state.lock");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("instance state exclusion", () => {
  it("excludes a competing restore until the server releases its OS lock", () => {
    const file = path();
    const release = acquireInstanceLock(file, "server");
    expect(readInstanceLock(file)).toEqual({ pid: process.pid, kind: "server" });
    expect(() => acquireInstanceLock(file, "restore")).toThrow("already in use");
    release();
    expect(readInstanceLock(file)).toBeNull();
    const restoreRelease = acquireInstanceLock(file, "restore");
    expect(readInstanceLock(file)?.kind).toBe("restore");
    restoreRelease();
  });
  it("recovers stale metadata without treating it as exclusive ownership", () => {
    const file = path();
    writeFileSync(file, JSON.stringify({ pid: 2147483647, kind: "server" }));
    expect(readInstanceLock(file)).toBeNull();
    const release = acquireInstanceLock(file, "restore");
    release();
  });
});
