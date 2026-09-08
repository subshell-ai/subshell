import { describe, expect, it } from "bun:test";
import { hasActivity, POLL_ACTIVE_MS, POLL_IDLE_MS, pollIntervalMs } from "@/lib/poll-policy";

describe("pollIntervalMs", () => {
  it("3 s while anything runs/waits, 15 s quiescent, stopped in background (spec §Transport)", () => {
    expect(pollIntervalMs({ foreground: true, hasActivity: true })).toBe(POLL_ACTIVE_MS);
    expect(pollIntervalMs({ foreground: true, hasActivity: false })).toBe(POLL_IDLE_MS);
    expect(pollIntervalMs({ foreground: false, hasActivity: true })).toBeNull();
    expect(pollIntervalMs({ foreground: false, hasActivity: false })).toBeNull();
  });

  it("keeps the spec's exact numbers", () => {
    expect(POLL_ACTIVE_MS).toBe(3000);
    expect(POLL_IDLE_MS).toBe(15000);
  });
});

describe("hasActivity", () => {
  it("alive running rows mean activity; dead-only lists are quiescent", () => {
    expect(hasActivity([{ status: "running", alive: true }])).toBe(true);
    expect(hasActivity([{ status: "running", alive: false }])).toBe(false);
    expect(hasActivity([{ status: "terminated", alive: false }])).toBe(false);
    expect(hasActivity([])).toBe(false);
  });
});
