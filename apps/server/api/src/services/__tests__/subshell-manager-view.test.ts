import { describe, expect, it } from "bun:test";
import { toSubshellView } from "@/services/subshell-manager.service.js";

/**
 * Pins the notification fields of the subshell view mapping. The frontend
 * mirror (`apps/server/web/src/types/subshell.ts`) is hand-maintained and the
 * REST schema (`src/api/models.ts`) strips undeclared fields, so this pure
 * mapping is the seam where a silent shape change would surface.
 */
function row(overrides: Partial<Parameters<typeof toSubshellView>[0]> = {}) {
  return {
    id: "s1",
    userId: "u1",
    presetId: "p1",
    harnessId: "claude",
    nodeId: "local",
    name: "subshell",
    workingDir: "/tmp",
    status: "running",
    createdAt: "2026-08-30T10:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    alive: 1,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: 0,
    nextRestartAt: null,
    nameLocked: 0,
    notify: 0,
    waitingSince: null,
    lastPushUrgency: null,
    crossAgent: 0,
    ...overrides,
  } satisfies Parameters<typeof toSubshellView>[0];
}

describe("toSubshellView notification fields", () => {
  it("maps notify 1/0 to booleans and passes waitingSince through", () => {
    const waiting = toSubshellView(row({ notify: 1, waitingSince: "2026-08-30T10:00:00.000Z" }), "running");
    expect(waiting.notify).toBe(true);
    expect(waiting.waitingSince).toBe("2026-08-30T10:00:00.000Z");

    const idle = toSubshellView(row(), "running");
    expect(idle.notify).toBe(false);
    expect(idle.waitingSince).toBeNull();
  });

  it("maps crossAgent 1/0 to a boolean (an MCP-launched pane files as cross-agent comms)", () => {
    expect(toSubshellView(row({ crossAgent: 1 }), "running").crossAgent).toBe(true);
    expect(toSubshellView(row({ crossAgent: 0 }), "running").crossAgent).toBe(false);
  });

  it("defaults access to 'owner' and honours an explicit override (sharing, spec 2026-08-31)", () => {
    // A returned view is always visible to someone, so it never carries "none".
    expect(toSubshellView(row(), "running").access).toBe("owner");
    expect(toSubshellView(row(), "running", [], "view").access).toBe("view");
    expect(toSubshellView(row(), "running", [], "edit").access).toBe("edit");
  });
});

describe("toSubshellView harness staleness (spec 2026-09-28 §4)", () => {
  it("stale only when stamp and current are both known and differ", () => {
    const versions = new Map([["claude", "2.1.284"]]);
    const stale = toSubshellView({ ...row(), harnessVersion: "2.1.283" }, "running", [], "owner", false, versions);
    expect(stale.harnessStale).toBe(true);
    expect(stale.harnessVersion).toBe("2.1.283");
    expect(stale.harnessCurrentVersion).toBe("2.1.284");
    // No stamp (never launched under a version, or pre-column row): unknown.
    expect(
      toSubshellView({ ...row(), harnessVersion: null }, "running", [], "owner", false, versions).harnessStale,
    ).toBe(false);
    // Node snapshot unknown (no map at all — every legacy call site — or no
    // entry for this harness): unknown. Two nulls are an absence, not a
    // disagreement, so an unprobed pair never raises the flag.
    expect(toSubshellView({ ...row(), harnessVersion: "2.1.283" }, "running", [], "owner", false).harnessStale).toBe(
      false,
    );
    expect(
      toSubshellView({ ...row(), harnessVersion: "2.1.283" }, "running", [], "owner", false, new Map()).harnessStale,
    ).toBe(false);
    // Current version read through even when they agree (the UI line needs both
    // strings, and "up to date" has to be derivable without a second field).
    const same = toSubshellView({ ...row(), harnessVersion: "2.1.284" }, "running", [], "owner", false, versions);
    expect(same.harnessStale).toBe(false);
    expect(same.harnessCurrentVersion).toBe("2.1.284");
    // The stamp passes through as read, null becoming an explicit null.
    expect(toSubshellView(row(), "running").harnessVersion).toBeNull();
  });
});
