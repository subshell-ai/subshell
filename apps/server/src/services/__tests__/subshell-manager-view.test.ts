import { describe, expect, it } from "bun:test";
import { toSubshellView } from "@/services/subshell-manager.service.js";

/**
 * Pins the notification fields of the subshell view mapping. The frontend
 * mirror (`apps/frontend/src/types/subshell.ts`) is hand-maintained and the
 * REST schema (`src/api/models.ts`) strips undeclared fields, so this pure
 * mapping is the seam where a silent shape change would surface.
 */
function row(overrides: Partial<Parameters<typeof toSubshellView>[0]> = {}) {
  return {
    id: "s1",
    userId: "u1",
    profileId: "p1",
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

  it("defaults access to 'owner' and honours an explicit override (sharing, spec 2026-08-31)", () => {
    // A returned view is always visible to someone, so it never carries "none".
    expect(toSubshellView(row(), "running").access).toBe("owner");
    expect(toSubshellView(row(), "running", [], "view").access).toBe("view");
    expect(toSubshellView(row(), "running", [], "edit").access).toBe("edit");
  });
});
