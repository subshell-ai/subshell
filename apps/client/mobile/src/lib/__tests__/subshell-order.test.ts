import { describe, expect, it } from "bun:test";
import { isCompleted, isExited, isRunning, isWaiting, sectionize, waitingCount } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/** Minimal SubshellView factory — tests override only what the predicate reads. */
function make(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: crypto.randomUUID(),
    presetId: null,
    harnessId: "h",
    name: "s",
    workingDir: "/tmp",
    status: "running",
    createdAt: "2026-08-31T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
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
    access: "owner",
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

// Web parity (spec §5.6, mirroring the frontend subshell-card accessory rule):
// an unreachable node's stamps are last-known facts, so the Waiting bucket and
// the badge count must not advertise them — the "node unreachable" copy on the
// row owns the state instead. (The chip/border/dot gate itself is live in
// components/subshell-card.tsx; these two are the list-level markers.)
describe("nodeOffline suppresses waiting markers", () => {
  const STAMP = "2026-08-31T00:00:00.000Z";

  it("keeps an offline waiting row out of the Waiting bucket", () => {
    const offline = make({ name: "o", waitingSince: STAMP, nodeOffline: true });
    const s = sectionize([offline]);
    expect(s.waiting).toHaveLength(0);
    // Its `alive` is last-known, so it groups like the web's Running section.
    expect(s.running.map((x) => x.name)).toEqual(["o"]);
  });

  it("still buckets an offline row whose last-known pane was dead under exited", () => {
    const s = sectionize([make({ name: "o", alive: false, exitCode: 1, waitingSince: STAMP, nodeOffline: true })]);
    expect(s.waiting).toHaveLength(0);
    expect(s.exited.map((x) => x.name)).toEqual(["o"]);
  });

  it("waitingCount (the tab/icon-badge fallback) never counts offline rows", () => {
    expect(waitingCount([make({ waitingSince: STAMP, nodeOffline: true })])).toBe(0);
    // `=== true` posture: an older payload without the field reads online.
    expect(waitingCount([make({ waitingSince: STAMP })])).toBe(1);
  });
});

describe("lifecycle predicates", () => {
  // The scalars behind sectionize/hasActivity — pinned so the pill, the
  // buckets and the poll cannot drift apart silently (review, reuse #3).
  it("classifies the four lifecycle states", () => {
    const running = { status: "running", alive: true } as never;
    const exited = { status: "running", alive: false } as never;
    const completed = { status: "terminated", alive: false } as never;
    expect(isRunning(running)).toBe(true);
    expect(isRunning(exited)).toBe(false);
    expect(isExited(exited)).toBe(true);
    expect(isExited(running)).toBe(false);
    expect(isCompleted(completed)).toBe(true);
    expect(isCompleted(running)).toBe(false);
  });
});
