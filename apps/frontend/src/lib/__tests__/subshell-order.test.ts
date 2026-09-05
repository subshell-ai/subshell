import { describe, expect, it } from "bun:test";
import type { SubshellView } from "@/types/subshell";
import type { WorkspacePaneRow } from "@/types/workspace";
import { isPaneWaiting, isWaiting, priorityRunning, sortByCreation } from "../subshell-order";

/** A subshell with only the fields these helpers read. */
function subshell(overrides: Partial<SubshellView>): SubshellView {
  return {
    id: crypto.randomUUID(),
    name: "subshell",
    status: "running",
    alive: true,
    notify: false,
    waitingSince: null,
    ...overrides,
  } as SubshellView;
}

describe("isWaiting", () => {
  it("is true for a live running subshell stamped by the watcher", () => {
    expect(isWaiting(subshell({ waitingSince: "2026-08-30T10:00:00.000Z" }))).toBe(true);
  });

  it("is false without a stamp", () => {
    expect(isWaiting(subshell({ waitingSince: null }))).toBe(false);
  });

  it("is false for exited or terminated rows even with a stale stamp", () => {
    const stamp = "2026-08-30T10:00:00.000Z";
    expect(isWaiting(subshell({ waitingSince: stamp, alive: false }))).toBe(false);
    expect(isWaiting(subshell({ waitingSince: stamp, status: "terminated", alive: false }))).toBe(false);
  });
});

/** A full workspace pane row with overridable fields. */
function pane(overrides: Partial<WorkspacePaneRow> = {}): WorkspacePaneRow {
  return {
    id: "pane-1",
    subshellId: "s-1",
    subshellName: "pane",
    subshellStatus: "running",
    subshellAlive: true,
    subshellExitCode: null,
    subshellWaitingSince: null,
    workingDir: "/tmp",
    ...overrides,
  };
}

describe("isPaneWaiting", () => {
  it("is true for a live running pane stamped by the watcher", () => {
    expect(isPaneWaiting(pane({ subshellWaitingSince: "2026-08-30T10:00:00.000Z" }))).toBe(true);
  });

  it("is false without a stamp", () => {
    expect(isPaneWaiting(pane())).toBe(false);
  });

  it("agrees with isWaiting on exited or terminated rows even with a stale stamp", () => {
    const stamp = "2026-08-30T10:00:00.000Z";
    expect(isPaneWaiting(pane({ subshellWaitingSince: stamp, subshellAlive: false }))).toBe(false);
    expect(
      isPaneWaiting(pane({ subshellWaitingSince: stamp, subshellStatus: "terminated", subshellAlive: false })),
    ).toBe(false);
  });
});

describe("priorityRunning", () => {
  it("puts bell-on waiting subshells first and keeps the rest in order", () => {
    const a = subshell({ name: "a", notify: true, waitingSince: "2026-08-30T10:00:00.000Z" });
    const b = subshell({ name: "b", waitingSince: "2026-08-30T10:00:00.000Z" });
    const c = subshell({ name: "c" });
    const d = subshell({ name: "d", notify: true });

    expect(priorityRunning([a, b, c, d]).map((s) => s.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("moves a priority subshell ahead of earlier non-priority ones", () => {
    const c = subshell({ name: "c" });
    const a = subshell({ name: "a", notify: true, waitingSince: "2026-08-30T10:00:00.000Z" });

    expect(priorityRunning([c, a]).map((s) => s.name)).toEqual(["a", "c"]);
  });

  it("keeps the relative order of multiple priority subshells (stable)", () => {
    const a = subshell({ name: "a", notify: true, waitingSince: "2026-08-30T10:00:00.000Z" });
    const b = subshell({ name: "b", notify: true, waitingSince: "2026-08-30T09:00:00.000Z" });
    const c = subshell({ name: "c" });

    expect(priorityRunning([a, c, b]).map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  it("does not treat a muted waiting subshell as priority", () => {
    const muted = subshell({ name: "muted", notify: false, waitingSince: "2026-08-30T10:00:00.000Z" });
    const plain = subshell({ name: "plain" });

    expect(priorityRunning([muted, plain]).map((s) => s.name)).toEqual(["muted", "plain"]);
  });

  it("returns a copy rather than sorting the input in place", () => {
    const c = subshell({ name: "c" });
    const a = subshell({ name: "a", notify: true, waitingSince: "2026-08-30T10:00:00.000Z" });
    const input = [c, a];

    priorityRunning(input);

    expect(input.map((s) => s.name)).toEqual(["c", "a"]);
  });
});

describe("sortByCreation — the swipe's stable spine", () => {
  const at = (iso: string, id: string) => ({ id, createdAt: iso });

  it("orders newest-created first", () => {
    const out = sortByCreation([
      at("2026-09-01T00:00:00.000Z", "old"),
      at("2026-09-03T00:00:00.000Z", "new"),
      at("2026-09-02T00:00:00.000Z", "mid"),
    ]);
    expect(out.map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  it("does NOT move when activity changes — the whole point", () => {
    // The sidebar ranks by `activity` ("output within 60s"), so a subshell
    // printing a line jumps its band and the neighbours change under the
    // user's finger. Creation order cannot: it reads no such field.
    const rows = [
      { ...at("2026-09-01T00:00:00.000Z", "a"), activity: "idle" },
      { ...at("2026-09-02T00:00:00.000Z", "b"), activity: "idle" },
      { ...at("2026-09-03T00:00:00.000Z", "c"), activity: "idle" },
    ];
    const before = sortByCreation(rows).map((s) => s.id);
    const afterBurst = sortByCreation(rows.map((r) => (r.id === "a" ? { ...r, activity: "active" } : r))).map(
      (s) => s.id,
    );
    expect(afterBurst).toEqual(before);
  });

  it("is independent of the input order", () => {
    const rows = [
      at("2026-09-01T00:00:00.000Z", "a"),
      at("2026-09-02T00:00:00.000Z", "b"),
      at("2026-09-03T00:00:00.000Z", "c"),
    ];
    const forward = sortByCreation(rows).map((s) => s.id);
    expect(sortByCreation([...rows].reverse()).map((s) => s.id)).toEqual(forward);
  });

  it("stays deterministic when two rows share a timestamp", () => {
    const same = "2026-09-02T00:00:00.000Z";
    const one = sortByCreation([at(same, "b"), at(same, "a")]).map((s) => s.id);
    const two = sortByCreation([at(same, "a"), at(same, "b")]).map((s) => s.id);
    expect(one).toEqual(two);
  });

  it("does not mutate its input", () => {
    const rows = [at("2026-09-01T00:00:00.000Z", "a"), at("2026-09-03T00:00:00.000Z", "c")];
    sortByCreation(rows);
    expect(rows.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("survives an unparseable timestamp rather than scrambling the list", () => {
    const out = sortByCreation([at("not-a-date", "bad"), at("2026-09-02T00:00:00.000Z", "good")]);
    expect(out.map((s) => s.id).sort()).toEqual(["bad", "good"]);
  });
});
