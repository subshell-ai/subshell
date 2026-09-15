import { describe, expect, it } from "bun:test";
import { clampAdoptedStamp, decideMaintenance } from "@/services/nodes/maintenance.js";

/**
 * The reconciliation table (spec 2026-09-14 §5.2) — the pure half, asserted
 * without a database, a socket or a clock.
 *
 * The state is ONE flag with two copies. Either may be written while the other
 * is unreachable, so the whole rule is: the newer `changedAt` wins, a tie goes
 * to the plane (the record), and a stamp that cannot be compared never wins.
 */

/** A node row, reduced to the two fields the decision reads. */
const row = (maintenance: 0 | 1, maintenanceAt: string | null) => ({ maintenance, maintenanceAt });

describe("decideMaintenance — absences", () => {
  it("neither end has an opinion → noop", () => {
    expect(decideMaintenance(row(0, null), undefined)).toBe("noop");
  });

  it("the node has no file but the plane has a value → push it down", () => {
    // The usual shape of a re-enrolled machine, or one whose data dir was
    // wiped: the plane is the record, so it re-arms the mirror.
    expect(decideMaintenance(row(1, "2026-09-14T10:00:00.000Z"), undefined)).toBe("push-plane");
    expect(decideMaintenance(row(0, "2026-09-14T10:00:00.000Z"), undefined)).toBe("push-plane");
  });

  it("the node has a file and the plane never wrote one → adopt", () => {
    expect(decideMaintenance(row(0, null), { on: true, changedAt: "2026-09-14T10:00:00.000Z" })).toBe("adopt-node");
    // Even for an "off" report: adopting records the stamp, which is what lets
    // the NEXT disagreement be decided at all.
    expect(decideMaintenance(row(0, null), { on: false, changedAt: "2026-09-14T10:00:00.000Z" })).toBe("adopt-node");
  });
});

describe("decideMaintenance — two stamps", () => {
  it("the newer stamp wins, in both directions", () => {
    expect(
      decideMaintenance(row(0, "2026-09-14T10:00:00.000Z"), { on: true, changedAt: "2026-09-14T11:00:00.000Z" }),
    ).toBe("adopt-node");
    expect(
      decideMaintenance(row(1, "2026-09-14T12:00:00.000Z"), { on: false, changedAt: "2026-09-14T11:00:00.000Z" }),
    ).toBe("push-plane");
  });

  it("equal stamps are a noop — the tie goes to the plane, which is the record", () => {
    const at = "2026-09-14T10:00:00.000Z";
    expect(decideMaintenance(row(1, at), { on: true, changedAt: at })).toBe("noop");
  });

  it("equal stamps with a DIFFERING flag are still a noop, not a fight", () => {
    // Pathological (two writes in the same millisecond). Answering anything
    // else here would send a command on every heartbeat for as long as the
    // two disagreed; the next real flip realigns them.
    const at = "2026-09-14T10:00:00.000Z";
    expect(decideMaintenance(row(1, at), { on: false, changedAt: at })).toBe("noop");
  });

  it("compares instants, not strings: the same moment spelled two ways is a tie", () => {
    expect(
      decideMaintenance(row(1, "2026-09-14T10:00:00.000Z"), { on: true, changedAt: "2026-09-14T12:00:00+02:00" }),
    ).toBe("noop");
  });

  it("an unparseable node stamp loses, rather than becoming unbeatable", () => {
    // Adopting a value nothing can compare would freeze the node's copy as
    // permanently authoritative — no later plane flip could ever outrank it.
    expect(decideMaintenance(row(0, "2026-09-14T10:00:00.000Z"), { on: true, changedAt: "yesterday" })).toBe(
      "push-plane",
    );
    // …and with no plane stamp either, there is still nothing to push a
    // comparison against, so the plane's (unwritten) value stands.
    expect(decideMaintenance(row(0, null), { on: true, changedAt: "yesterday" })).toBe("push-plane");
  });
});

describe("clampAdoptedStamp", () => {
  const now = "2026-09-14T10:00:00.000Z";

  it("leaves a stamp at or before now alone", () => {
    expect(clampAdoptedStamp("2026-09-14T09:59:59.000Z", now)).toBe("2026-09-14T09:59:59.000Z");
    expect(clampAdoptedStamp(now, now)).toBe(now);
  });

  it("clamps a future-dated machine clock to now", () => {
    // Unclamped, a machine an hour fast writes a stamp no plane flip in the
    // next hour could beat — the owner's browser switch would silently lose.
    expect(clampAdoptedStamp("2026-09-14T11:00:00.000Z", now)).toBe(now);
  });

  it("falls back to now for a stamp it cannot read", () => {
    expect(clampAdoptedStamp("whenever", now)).toBe(now);
  });
});
