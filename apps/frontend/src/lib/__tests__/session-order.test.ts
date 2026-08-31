import { describe, expect, it } from "bun:test";
import type { SessionView } from "@/types/session";
import type { WorkspacePaneRow } from "@/types/workspace";
import { isPaneWaiting, isWaiting, priorityRunning } from "../session-order";

/** A session with only the fields these helpers read. */
function session(overrides: Partial<SessionView>): SessionView {
  return {
    id: crypto.randomUUID(),
    name: "session",
    status: "running",
    alive: true,
    notify: false,
    waitingSince: null,
    ...overrides,
  } as SessionView;
}

describe("isWaiting", () => {
  it("is true for a live running session stamped by the watcher", () => {
    expect(isWaiting(session({ waitingSince: "2026-08-30T10:00:00.000Z" }))).toBe(true);
  });

  it("is false without a stamp", () => {
    expect(isWaiting(session({ waitingSince: null }))).toBe(false);
  });

  it("is false for exited or terminated rows even with a stale stamp", () => {
    const stamp = "2026-08-30T10:00:00.000Z";
    expect(isWaiting(session({ waitingSince: stamp, alive: false }))).toBe(false);
    expect(isWaiting(session({ waitingSince: stamp, status: "terminated", alive: false }))).toBe(false);
  });
});

/** A full workspace pane row with overridable fields. */
function pane(overrides: Partial<WorkspacePaneRow> = {}): WorkspacePaneRow {
  return {
    id: "pane-1",
    sessionId: "s-1",
    sessionName: "pane",
    sessionStatus: "running",
    sessionAlive: true,
    sessionExitCode: null,
    sessionWaitingSince: null,
    workingDir: "/tmp",
    ...overrides,
  };
}

describe("isPaneWaiting", () => {
  it("is true for a live running pane stamped by the watcher", () => {
    expect(isPaneWaiting(pane({ sessionWaitingSince: "2026-08-30T10:00:00.000Z" }))).toBe(true);
  });

  it("is false without a stamp", () => {
    expect(isPaneWaiting(pane())).toBe(false);
  });

  it("agrees with isWaiting on exited or terminated rows even with a stale stamp", () => {
    const stamp = "2026-08-30T10:00:00.000Z";
    expect(isPaneWaiting(pane({ sessionWaitingSince: stamp, sessionAlive: false }))).toBe(false);
    expect(isPaneWaiting(pane({ sessionWaitingSince: stamp, sessionStatus: "terminated", sessionAlive: false }))).toBe(
      false,
    );
  });
});

describe("priorityRunning", () => {
  it("puts bell-on waiting sessions first and keeps the rest in order", () => {
    const a = session({ name: "a", notify: true, waitingSince: "2026-08-30T10:00:00.000Z" });
    const b = session({ name: "b", waitingSince: "2026-08-30T10:00:00.000Z" });
    const c = session({ name: "c" });
    const d = session({ name: "d", notify: true });

    expect(priorityRunning([a, b, c, d]).map((s) => s.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("moves a priority session ahead of earlier non-priority ones", () => {
    const c = session({ name: "c" });
    const a = session({ name: "a", notify: true, waitingSince: "2026-08-30T10:00:00.000Z" });

    expect(priorityRunning([c, a]).map((s) => s.name)).toEqual(["a", "c"]);
  });

  it("keeps the relative order of multiple priority sessions (stable)", () => {
    const a = session({ name: "a", notify: true, waitingSince: "2026-08-30T10:00:00.000Z" });
    const b = session({ name: "b", notify: true, waitingSince: "2026-08-30T09:00:00.000Z" });
    const c = session({ name: "c" });

    expect(priorityRunning([a, c, b]).map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  it("does not treat a muted waiting session as priority", () => {
    const muted = session({ name: "muted", notify: false, waitingSince: "2026-08-30T10:00:00.000Z" });
    const plain = session({ name: "plain" });

    expect(priorityRunning([muted, plain]).map((s) => s.name)).toEqual(["muted", "plain"]);
  });

  it("returns a copy rather than sorting the input in place", () => {
    const c = session({ name: "c" });
    const a = session({ name: "a", notify: true, waitingSince: "2026-08-30T10:00:00.000Z" });
    const input = [c, a];

    priorityRunning(input);

    expect(input.map((s) => s.name)).toEqual(["c", "a"]);
  });
});
