import { describe, expect, it } from "bun:test";
import { isWaiting, sectionize, waitingCount } from "@/lib/session-order";
import type { SessionView } from "@/types/session";

/** Minimal SessionView factory — tests override only what the predicate reads. */
function make(over: Partial<SessionView> = {}): SessionView {
  return {
    id: crypto.randomUUID(),
    profileId: "p",
    harnessId: "h",
    name: "s",
    workingDir: "/tmp",
    status: "running",
    createdAt: "2026-08-31T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    notes: null,
    activity: "active",
    preview: [],
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    nameLocked: false,
    notify: false,
    waitingSince: null,
    ...over,
  };
}

describe("isWaiting", () => {
  it("mirrors the web predicate: running AND alive AND stamped", () => {
    expect(isWaiting(make({ waitingSince: "2026-08-31T00:00:00.000Z" }))).toBe(true);
    expect(isWaiting(make({ waitingSince: null }))).toBe(false);
    // A stale stamp on a dead row never counts (web comment: dead is never "waiting for you").
    expect(isWaiting(make({ alive: false, waitingSince: "2026-08-31T00:00:00.000Z" }))).toBe(false);
    expect(isWaiting(make({ status: "terminated", alive: false, waitingSince: "2026-08-31T00:00:00.000Z" }))).toBe(
      false,
    );
  });
});

describe("sectionize", () => {
  it("splits into Waiting / Running / Paused-exited / Completed like the web groups", () => {
    const waiting = make({ name: "w", waitingSince: "2026-08-31T00:00:00.000Z" });
    const running = make({ name: "r" });
    const exited = make({ name: "e", alive: false, exitCode: 1 });
    const completed = make({ name: "c", status: "terminated", alive: false });
    const s = sectionize([completed, exited, running, waiting]);
    expect(s.waiting.map((x) => x.name)).toEqual(["w"]);
    expect(s.running.map((x) => x.name)).toEqual(["r"]);
    expect(s.exited.map((x) => x.name)).toEqual(["e"]);
    expect(s.completed.map((x) => x.name)).toEqual(["c"]);
    // Elements are passed through by identity; a waiting row leaves Running entirely.
    expect(s.waiting[0]).toBe(waiting);
    expect(sectionize([waiting]).running).toHaveLength(0);
  });

  it("is pure — input array untouched, buckets are copies", () => {
    const input = [make({ name: "a" }), make({ name: "b", status: "terminated", alive: false })];
    const snapshot = [...input];
    sectionize(input);
    expect(input).toEqual(snapshot);
  });
});

describe("waitingCount", () => {
  it("counts only live stamped rows", () => {
    expect(
      waitingCount([
        make({ waitingSince: "2026-08-31T00:00:00.000Z" }),
        make({ waitingSince: "2026-08-31T00:00:00.000Z", alive: false }),
        make(),
      ]),
    ).toBe(1);
  });
});
