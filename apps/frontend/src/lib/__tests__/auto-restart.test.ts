import { describe, expect, it } from "bun:test";
import type { SubshellView } from "@/types/subshell";
import { describeAutoRestart } from "../auto-restart";

/** A subshell carrying only the auto-restart fields this helper reads. */
function subshell(overrides: Partial<SubshellView>): SubshellView {
  return {
    id: "s1",
    name: "subshell",
    backoffCount: 0,
    nextRestartAt: null,
    ...overrides,
  } as SubshellView;
}

/** Stand-in for the table's relative-time formatter. */
const elapsed = () => "2m";

describe("describeAutoRestart", () => {
  it("says nothing when the subshell has never needed restarting", () => {
    expect(describeAutoRestart(subshell({}), elapsed)).toBe("—");
  });

  it("reports a first attempt already scheduled, before any failure is counted", () => {
    // The subshell is down but on its way back — worth saying, and the bare
    // count would have shown a dash here.
    expect(describeAutoRestart(subshell({ nextRestartAt: "2026-01-01T00:00:00.000Z" }), elapsed)).toBe("restarting…");
  });

  it("counts a single retry in the singular", () => {
    expect(describeAutoRestart(subshell({ backoffCount: 1 }), elapsed)).toBe("1 retry");
  });

  it("counts several in the plural, with the next attempt when one is due", () => {
    expect(describeAutoRestart(subshell({ backoffCount: 3, nextRestartAt: "2026-01-01T00:00:00.000Z" }), elapsed)).toBe(
      "3 retries · next in 2m",
    );
  });

  it("omits the next attempt when none is scheduled", () => {
    expect(describeAutoRestart(subshell({ backoffCount: 2 }), elapsed)).toBe("2 retries");
  });

  it("says the server gave up at the try limit, rather than promising another attempt", () => {
    expect(describeAutoRestart(subshell({ backoffCount: 5, nextRestartAt: "2026-01-01T00:00:00.000Z" }), elapsed)).toBe(
      "5 retries · gave up",
    );
    expect(describeAutoRestart(subshell({ backoffCount: 9 }), elapsed)).toBe("9 retries · gave up");
  });
});
