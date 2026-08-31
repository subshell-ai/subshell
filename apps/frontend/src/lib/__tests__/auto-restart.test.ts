import { describe, expect, it } from "bun:test";
import type { SessionView } from "@/types/session";
import { describeAutoRestart } from "../auto-restart";

/** A session carrying only the auto-restart fields this helper reads. */
function session(overrides: Partial<SessionView>): SessionView {
  return {
    id: "s1",
    name: "session",
    backoffCount: 0,
    nextRestartAt: null,
    ...overrides,
  } as SessionView;
}

/** Stand-in for the table's relative-time formatter. */
const elapsed = () => "2m";

describe("describeAutoRestart", () => {
  it("says nothing when the session has never needed restarting", () => {
    expect(describeAutoRestart(session({}), elapsed)).toBe("—");
  });

  it("reports a first attempt already scheduled, before any failure is counted", () => {
    // The session is down but on its way back — worth saying, and the bare
    // count would have shown a dash here.
    expect(describeAutoRestart(session({ nextRestartAt: "2026-01-01T00:00:00.000Z" }), elapsed)).toBe("restarting…");
  });

  it("counts a single retry in the singular", () => {
    expect(describeAutoRestart(session({ backoffCount: 1 }), elapsed)).toBe("1 retry");
  });

  it("counts several in the plural, with the next attempt when one is due", () => {
    expect(describeAutoRestart(session({ backoffCount: 3, nextRestartAt: "2026-01-01T00:00:00.000Z" }), elapsed)).toBe(
      "3 retries · next in 2m",
    );
  });

  it("omits the next attempt when none is scheduled", () => {
    expect(describeAutoRestart(session({ backoffCount: 2 }), elapsed)).toBe("2 retries");
  });

  it("says the server gave up at the try limit, rather than promising another attempt", () => {
    expect(describeAutoRestart(session({ backoffCount: 5, nextRestartAt: "2026-01-01T00:00:00.000Z" }), elapsed)).toBe(
      "5 retries · gave up",
    );
    expect(describeAutoRestart(session({ backoffCount: 9 }), elapsed)).toBe("9 retries · gave up");
  });
});
