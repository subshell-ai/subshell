import { describe, expect, it } from "bun:test";
import { toSessionView } from "@/services/session-manager.service.js";

/**
 * Pins the notification fields of the session view mapping. The frontend
 * mirror (`apps/frontend/src/types/session.ts`) is hand-maintained and the
 * REST schema (`src/api/models.ts`) strips undeclared fields, so this pure
 * mapping is the seam where a silent shape change would surface.
 */
function row(overrides: Partial<Parameters<typeof toSessionView>[0]> = {}) {
  return {
    id: "s1",
    userId: "u1",
    profileId: "p1",
    harnessId: "claude",
    name: "session",
    workingDir: "/tmp",
    status: "running",
    createdAt: "2026-08-30T10:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    notes: null,
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
  } satisfies Parameters<typeof toSessionView>[0];
}

describe("toSessionView notification fields", () => {
  it("maps notify 1/0 to booleans and passes waitingSince through", () => {
    const waiting = toSessionView(row({ notify: 1, waitingSince: "2026-08-30T10:00:00.000Z" }), "running");
    expect(waiting.notify).toBe(true);
    expect(waiting.waitingSince).toBe("2026-08-30T10:00:00.000Z");

    const idle = toSessionView(row(), "running");
    expect(idle.notify).toBe(false);
    expect(idle.waitingSince).toBeNull();
  });
});
