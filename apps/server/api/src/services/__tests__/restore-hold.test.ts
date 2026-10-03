import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeRestoreHold,
  clearRestoreHold,
  RESTORE_HOLD_MAX_MS,
  restoreHoldPath,
  writeRestoreHold,
} from "@/services/restore-hold.js";

const dirs: string[] = [];
const config = () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-hold-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("restore hold", () => {
  it("claims the hold for the live writer and clears it", () => {
    const dir = config();
    expect(activeRestoreHold(dir)).toBe(false);
    writeRestoreHold(dir);
    expect(restoreHoldPath(dir)).toBe(join(dir, "restore-in-progress.json"));
    // This test process is alive, so the hold it just wrote is active.
    expect(activeRestoreHold(dir)).toBe(true);
    clearRestoreHold(dir);
    expect(activeRestoreHold(dir)).toBe(false);
  });

  it("a marker naming a dead pid never holds (a crashed worker self-clears)", () => {
    const dir = config();
    // pid 0x7FFFFFFF is reserved on Linux and can never be a live process;
    // a stale marker from a worker that died mid-apply must not strand the
    // native parent, or the box never boots its server again. Fresh `at` so
    // this proves the LIVENESS gate, not the age gate.
    writeFileSync(restoreHoldPath(dir), JSON.stringify({ pid: 2147483647, kind: "restore", at: Date.now() }), {
      mode: 0o600,
    });
    expect(activeRestoreHold(dir)).toBe(false);
  });

  it("an old marker never holds even on a LIVE pid (the unreaped-zombie case)", () => {
    const dir = config();
    // A worker SIGKILLed mid-swap becomes a zombie that still answers kill -0,
    // so liveness alone would defer the respawn forever. The age bound is what
    // releases it: this test's OWN pid is alive, but a stamp past the bound is
    // no longer a hold.
    writeFileSync(
      restoreHoldPath(dir),
      JSON.stringify({ pid: process.pid, kind: "restore", at: Date.now() - (RESTORE_HOLD_MAX_MS + 1) }),
      { mode: 0o600 },
    );
    expect(activeRestoreHold(dir)).toBe(false);
    // The same live pid WITHIN the bound does hold — the age, not the pid, flipped it.
    writeFileSync(restoreHoldPath(dir), JSON.stringify({ pid: process.pid, kind: "restore", at: Date.now() }), {
      mode: 0o600,
    });
    expect(activeRestoreHold(dir)).toBe(true);
  });

  it("an unreadable, malformed, non-pid, or `at`-less marker fails open to a respawn", () => {
    const dir = config();
    writeFileSync(restoreHoldPath(dir), "not json", { mode: 0o600 });
    expect(activeRestoreHold(dir)).toBe(false);
    writeFileSync(restoreHoldPath(dir), JSON.stringify({ kind: "restore", at: Date.now() }), { mode: 0o600 }); // no pid
    expect(activeRestoreHold(dir)).toBe(false);
    writeFileSync(restoreHoldPath(dir), JSON.stringify({ pid: -1, at: Date.now() }), { mode: 0o600 }); // not a real pid
    expect(activeRestoreHold(dir)).toBe(false);
    writeFileSync(restoreHoldPath(dir), JSON.stringify({ pid: "42", at: Date.now() }), { mode: 0o600 }); // string pid
    expect(activeRestoreHold(dir)).toBe(false);
    // A live pid with NO usable `at` is not trusted: deferring for a timestamp
    // we cannot read risks a never-coming-back stall, and the swap lock (not the
    // marker) is the real exclusion, so failing open only costs a crash-loop.
    writeFileSync(restoreHoldPath(dir), JSON.stringify({ pid: process.pid, kind: "restore" }), { mode: 0o600 });
    expect(activeRestoreHold(dir)).toBe(false);
  });

  it("writes the marker 0600, because it lives beside config.env", () => {
    const dir = config();
    writeRestoreHold(dir);
    // A bare `File::create`/writeFileSync without the mode takes the umask,
    // which on a shared host is world-readable; this file sits beside the
    // instance secrets. Assert the bits, not just that bytes were written.
    expect(lstatSync(restoreHoldPath(dir)).mode & 0o777).toBe(0o600);
  });
});
