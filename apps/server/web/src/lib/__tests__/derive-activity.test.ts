import { describe, expect, it } from "bun:test";
import { ACTIVE_WINDOW_MS, deriveActivity, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function view(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    lastOutputAt: ago(1_000),
    ...over,
  } as SubshellView;
}

describe("deriveActivity — the clock, not the server's stamp", () => {
  it("calls recent output active", () => {
    expect(deriveActivity(view({ lastOutputAt: ago(1_000) }), NOW)).toBe("active");
  });

  /**
   * The whole reason this exists: with the feed event-driven, NOTHING arrives
   * to mark elapsed time. The server's `activity` here still says "active" —
   * it was computed when the row was last written — and believing it would
   * leave a quiet subshell reading as working forever.
   */
  it("calls a quiet subshell idle even while the server's stamp still says active", () => {
    const stale = view({ activity: "active", lastOutputAt: ago(ACTIVE_WINDOW_MS + 5_000) });
    expect(stale.activity).toBe("active");
    expect(deriveActivity(stale, NOW)).toBe("idle");
    expect(subshellIndicator(stale)).not.toBe("waiting");
  });

  it("treats the window edge as still active", () => {
    expect(deriveActivity(view({ lastOutputAt: ago(ACTIVE_WINDOW_MS) }), NOW)).toBe("active");
    expect(deriveActivity(view({ lastOutputAt: ago(ACTIVE_WINDOW_MS + 1) }), NOW)).toBe("idle");
  });

  it("never turns a terminated subshell back into a working one", () => {
    const dead = view({ activity: "terminated", status: "terminated", lastOutputAt: ago(10) });
    expect(deriveActivity(dead, NOW)).toBe("terminated");
  });

  it("falls back to the server's answer when there is no stamp to measure", () => {
    expect(deriveActivity(view({ lastOutputAt: null, activity: "idle" }), NOW)).toBe("idle");
    expect(deriveActivity(view({ lastOutputAt: "not a date", activity: "active" }), NOW)).toBe("active");
  });

  it("does not outrank the states above it in the indicator's precedence", () => {
    const quiet = { lastOutputAt: ago(ACTIVE_WINDOW_MS + 5_000), activity: "active" as const };
    expect(subshellIndicator(view({ ...quiet, nodeOffline: true }))).toBe("node-offline");
    expect(subshellIndicator(view({ ...quiet, alive: false }))).toBe("exited");
    expect(subshellIndicator(view({ ...quiet, waitingSince: ago(1_000) }))).toBe("waiting");
  });
});
