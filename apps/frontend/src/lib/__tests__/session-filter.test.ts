import { describe, expect, it } from "bun:test";
import type { SessionView } from "@/types/session";
import { filterSessions, groupSessions } from "../session-filter";

/** A session with only the fields these helpers read. */
function session(overrides: Partial<SessionView>): SessionView {
  return {
    id: crypto.randomUUID(),
    profileId: "p1",
    harnessId: "claude",
    name: "session",
    workingDir: "/mnt/code",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    alive: true,
    activity: "active",
    ...overrides,
  } as SessionView;
}

describe("filterSessions", () => {
  const sessions = [
    session({ name: "Alpha", workingDir: "/mnt/code", harnessId: "claude" }),
    session({ name: "Bravo", workingDir: "/srv/api", harnessId: "codex" }),
  ];

  it("returns the input untouched for an empty or whitespace query", () => {
    expect(filterSessions(sessions, "")).toBe(sessions);
    expect(filterSessions(sessions, "   ")).toBe(sessions);
  });

  it("matches on name, path or harness, case-insensitively", () => {
    expect(filterSessions(sessions, "alpha").map((s) => s.name)).toEqual(["Alpha"]);
    expect(filterSessions(sessions, "/SRV").map((s) => s.name)).toEqual(["Bravo"]);
    expect(filterSessions(sessions, "codex").map((s) => s.name)).toEqual(["Bravo"]);
  });

  it("returns nothing when a query matches no field", () => {
    expect(filterSessions(sessions, "nothing-here")).toEqual([]);
  });
});

describe("groupSessions", () => {
  it("splits running, exited-but-tracked, and terminated", () => {
    const running = session({ name: "run", status: "running", alive: true });
    const exited = session({ name: "exit", status: "running", alive: false });
    const terminated = session({ name: "done", status: "terminated", alive: false });

    const groups = groupSessions([running, exited, terminated]);

    expect(groups.running.map((s) => s.name)).toEqual(["run"]);
    expect(groups.exited.map((s) => s.name)).toEqual(["exit"]);
    expect(groups.terminated.map((s) => s.name)).toEqual(["done"]);
  });

  it("returns three empty groups for no sessions", () => {
    expect(groupSessions([])).toEqual({ running: [], exited: [], terminated: [] });
  });
});
