import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintenancePath, readMaintenance, reportableMaintenance, writeMaintenance } from "../maintenance.js";
import { captureLogs } from "./helpers/capture-logs.js";

/**
 * The maintenance mirror primitive (spec 2026-09-14 §4.1) — persistence, the
 * file mode, and the FAIL-CLOSED read that is the whole reason this file is
 * not a second copy of `allowed-dirs.ts`.
 *
 * `commands-maintenance.test.ts` covers the wiring (the launch gate, the
 * `set_maintenance` handler, the reporting order); this covers the primitive
 * those depend on.
 */

const made: string[] = [];

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subshell-maint-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The mirror's own mtime, as the unreadable branch stamps it. */
function mtimeOf(dataDir: string): string {
  return statSync(maintenancePath(dataDir)).mtime.toISOString();
}

describe("persistence", () => {
  it("round-trips the exact stamp it was given", () => {
    const dataDir = freshDataDir();
    const state = { on: true, changedAt: "2026-09-14T10:00:00.000Z" };
    expect(writeMaintenance(dataDir, state)).toEqual(state);
    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state });
  });

  it("stores `on: false` as a VALUE, not as an absent file", () => {
    // Ending maintenance must leave a stamp behind: the plane reconciles on
    // `changedAt`, and a node that answered "no file" after being turned off
    // would lose to the plane's older "on" on the next reconnect.
    const dataDir = freshDataDir();
    const state = { on: false, changedAt: "2026-09-14T11:00:00.000Z" };
    writeMaintenance(dataDir, state);
    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state });
  });

  it("writes the file 0600 — it is a fact about this machine, not a public one", () => {
    const dataDir = freshDataDir();
    writeMaintenance(dataDir, { on: true, changedAt: "2026-09-14T10:00:00.000Z" });
    expect(statSync(maintenancePath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("creates a missing data dir 0700 rather than throwing", () => {
    const dataDir = join(freshDataDir(), "nested", "data");
    writeMaintenance(dataDir, { on: true, changedAt: "2026-09-14T10:00:00.000Z" });
    expect(existsSync(maintenancePath(dataDir))).toBe(true);
  });

  it("leaves no temp file behind, and the file it leaves is whole", () => {
    // Atomicity matters here for the same reason it does in allowed-dirs: a
    // launch can read this at any instant, and a half-written file reads as
    // corrupt — which under the fail-closed rule REFUSES every launch for as
    // long as the write takes, rather than merely widening the node.
    const dataDir = freshDataDir();
    writeMaintenance(dataDir, { on: true, changedAt: "2026-09-14T10:00:00.000Z" });
    writeMaintenance(dataDir, { on: false, changedAt: "2026-09-14T12:00:00.000Z" });
    expect(readdirSync(dataDir)).toEqual(["maintenance.json"]);
    expect(JSON.parse(readFileSync(maintenancePath(dataDir), "utf8"))).toMatchObject({
      on: false,
      changedAt: "2026-09-14T12:00:00.000Z",
    });
  });

  it("replaces wholesale — the newer stamp is the only one left", () => {
    const dataDir = freshDataDir();
    writeMaintenance(dataDir, { on: true, changedAt: "2026-09-14T10:00:00.000Z" });
    writeMaintenance(dataDir, { on: true, changedAt: "2026-09-14T13:00:00.000Z" });
    expect(readMaintenance(dataDir)).toEqual({
      kind: "state",
      state: { on: true, changedAt: "2026-09-14T13:00:00.000Z" },
    });
  });
});

describe("reading is fail-CLOSED, unlike the allowlist beside it", () => {
  it("answers `absent` when no file has ever been written", () => {
    // The backwards-compatible default, and the one direction that is NOT
    // fail-closed: a node that has never been told anything keeps launching.
    expect(readMaintenance(freshDataDir())).toEqual({ kind: "absent" });
  });

  it("answers `unreadable` for corrupt JSON, and says so once", () => {
    const dataDir = freshDataDir();
    writeFileSync(maintenancePath(dataDir), "{not json");
    const cap = captureLogs();
    try {
      expect(readMaintenance(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes("maintenance"))).toHaveLength(1);
  });

  it("answers `unreadable` for a well-formed file missing a field", () => {
    // A hand-edit or a truncated write is not a state. The parse is the wire
    // shape's: both halves or nothing — a missing `changedAt` cannot be
    // reconciled against the plane's, so it is not a value to act on.
    const dataDir = freshDataDir();
    writeFileSync(maintenancePath(dataDir), JSON.stringify({ on: true }));
    const cap = captureLogs();
    try {
      expect(readMaintenance(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
    } finally {
      cap.restore();
    }
  });

  it("answers `unreadable` when `on` is not a boolean", () => {
    const dataDir = freshDataDir();
    writeFileSync(maintenancePath(dataDir), JSON.stringify({ on: "yes", changedAt: "2026-09-14T10:00:00.000Z" }));
    const cap = captureLogs();
    try {
      expect(readMaintenance(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
    } finally {
      cap.restore();
    }
  });
});

describe("an unreadable mirror is reported as the state it produces", () => {
  it("stamps it with the FILE'S OWN mtime — the one honest timestamp available", () => {
    // `now` would be a stamp nobody wrote and a different one every read, so
    // the memo would never suppress it and every heartbeat would re-announce
    // the same broken file. The mtime is when that file last changed, which
    // is the truth the plane is being asked to reconcile against.
    const dataDir = freshDataDir();
    writeFileSync(maintenancePath(dataDir), "{not json");
    const cap = captureLogs();
    try {
      const read = readMaintenance(dataDir);
      expect(read).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
      expect(reportableMaintenance(read)).toEqual({ on: true, changedAt: mtimeOf(dataDir) });
    } finally {
      cap.restore();
    }
  });

  it("stamps it the SAME on every read of an unchanged file", () => {
    // Stability is the whole reason the stamp is the mtime: the memo compares
    // by value, so a stamp that moved would flood the plane with one event per
    // heartbeat for a file nobody is touching.
    const dataDir = freshDataDir();
    writeFileSync(maintenancePath(dataDir), "{not json");
    const cap = captureLogs();
    try {
      expect(readMaintenance(dataDir)).toEqual(readMaintenance(dataDir));
    } finally {
      cap.restore();
    }
  });

  it("sends NOTHING when the file could not even be statted", () => {
    // The refusal stands (the gate reads `unreadable`, not the stamp), but
    // there is no timestamp to report — and inventing one hands the plane a
    // value to reconcile against that nobody wrote.
    expect(reportableMaintenance({ kind: "unreadable" })).toBeUndefined();
  });

  it("sends nothing for an absent mirror, and the state verbatim for a parsed one", () => {
    const state = { on: false, changedAt: "2026-09-14T10:00:00.000Z" };
    expect(reportableMaintenance({ kind: "absent" })).toBeUndefined();
    expect(reportableMaintenance({ kind: "state", state })).toBe(state);
  });
});
