import { describe, expect, it } from "bun:test";
import { INDICATOR_LABEL, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/** The five fields the probe reads; every other field is irrelevant here. */
const probe = (overrides: Partial<SubshellView> = {}): SubshellView =>
  ({
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    ...overrides,
  }) as SubshellView;

describe("subshellIndicator", () => {
  it("passes activity through for a plain live subshell", () => {
    expect(subshellIndicator(probe({ activity: "active" }))).toBe("active");
    expect(subshellIndicator(probe({ activity: "idle" }))).toBe("idle");
  });

  it("terminated passes through even though it is also a status", () => {
    expect(subshellIndicator(probe({ status: "terminated", alive: false, activity: "terminated" }))).toBe("terminated");
  });

  it("running-but-dead reads exited", () => {
    expect(subshellIndicator(probe({ alive: false, activity: "idle" }))).toBe("exited");
  });

  it("waiting outranks active/idle but requires the isWaiting fields", () => {
    expect(subshellIndicator(probe({ waitingSince: "2026-09-03T00:00:00.000Z" }))).toBe("waiting");
    // A dead subshell is never "waiting for you" (isWaiting's own guard).
    expect(subshellIndicator(probe({ alive: false, waitingSince: "2026-09-03T00:00:00.000Z" }))).toBe("exited");
  });

  it("node-offline outranks everything", () => {
    expect(
      subshellIndicator(probe({ nodeOffline: true, alive: false, waitingSince: "2026-09-03T00:00:00.000Z" })),
    ).toBe("node-offline");
    expect(subshellIndicator(probe({ nodeOffline: true, activity: "active" }))).toBe("node-offline");
  });

  it("an absent nodeOffline field (older payload) reads online-ish", () => {
    const noField = { ...probe(), nodeOffline: undefined } as unknown as SubshellView;
    expect(subshellIndicator(noField)).toBe("active");
  });

  it("labels match the words the cards use today", () => {
    expect(INDICATOR_LABEL.active).toBe("working");
    expect(INDICATOR_LABEL.idle).toBe("idle");
    expect(INDICATOR_LABEL.terminated).toBe("ended");
    expect(INDICATOR_LABEL.exited).toBe("exited");
    expect(INDICATOR_LABEL.waiting).toBe("waiting for you");
    expect(INDICATOR_LABEL["node-offline"]).toBe("node unreachable");
  });
});
