import { describe, expect, it } from "bun:test";
import { sectionsByStatus } from "@/lib/subshell-sections";
import type { SubshellView } from "@/types/subshell";

/** Sections by state: band order, empty bands skipped, input order kept. */
function s(overrides: Partial<SubshellView>): SubshellView {
  return {
    id: "x",
    status: "running",
    alive: true,
    nodeOffline: false,
    activity: "idle",
    lastOutputAt: null,
    waitingSince: null,
    ...overrides,
  } as SubshellView;
}

describe("sectionsByStatus", () => {
  it("orders bands by urgency, not by first appearance", () => {
    // Ended first in the input, waiting second — Waiting leads, Ended follows
    // (STATUS_RANK order: waiting → working → idle → … → ended).
    const sections = sectionsByStatus([
      // `activity: "terminated"` rides beside the status because that is how
      // the indicator reads it: a lifecycle fact the clock can't undo.
      s({ id: "t1", status: "terminated", activity: "terminated" }),
      s({ id: "w1", waitingSince: "2026-09-24T00:00:00.000Z" }),
    ]);
    expect(sections.map((x) => x.key)).toEqual(["waiting", "terminated"]);
    expect(sections.map((x) => x.label)).toEqual(["Waiting for you", "Ended"]);
  });

  it("skips empty bands and keeps input order inside one", () => {
    const sections = sectionsByStatus([s({ id: "a" }), s({ id: "b", nodeOffline: true }), s({ id: "c" })]);
    // offline outranks idle? No — idle (rank 2) sits ABOVE node-offline (3):
    // a live-and-quiet row is actionable, an unreachable one is not.
    expect(sections.map((x) => x.key)).toEqual(["idle", "node-offline"]);
    expect(sections[0]?.subshells.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("never carries a reveal: heading and title are the same word", () => {
    for (const sec of sectionsByStatus([s({ id: "a", status: "terminated" })])) {
      expect(sec.title).toBe(sec.label);
    }
  });

  it("agrees with the dot: exited is running-but-dead, not terminated", () => {
    // The precedence the dots render is the precedence the bands cut on —
    // one definition (subshellIndicator), so heading and dot can't disagree.
    const sections = sectionsByStatus([
      s({ id: "e", alive: false }),
      s({ id: "t", status: "terminated", activity: "terminated" }),
    ]);
    expect(sections.map((x) => x.key)).toEqual(["exited", "terminated"]);
    expect(sections.map((x) => x.label)).toEqual(["Exited", "Ended"]);
  });
});
