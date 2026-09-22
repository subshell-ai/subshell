import { describe, expect, it } from "bun:test";
import { reconnectPillVisible, statusAfterClose } from "@/components/subshell-terminal";

/**
 * Wave D's consumer half (review-input fix): what a close does to the page.
 * The terminal only renders while `closed` is false, so the table below IS
 * the recovery story — a 4004 refusal must arrive as NOT closed (the
 * terminal stays mounted, the hook's retry continues, and the retried
 * attach's onOpen arrives as `connected: true, closed: false`, clearing any
 * earlier state), while a refusal a retry cannot fix lands on the dead
 * panel.
 */
describe("statusAfterClose (Wave D recovery)", () => {
  it("a 4004 node-offline refusal does NOT close the page over the retry", () => {
    expect(statusAfterClose(4004)).toEqual({ connected: false, closed: false });
  });

  it("a refusal a retry cannot fix closes: unauthorized, not found, attach failed", () => {
    for (const code of [4000, 4001, 4005]) {
      expect(statusAfterClose(code)).toEqual({ connected: false, closed: true });
    }
  });

  it("sub-4000 drops and restarts stay transient, exactly as before", () => {
    for (const code of [1000, 1006, 1011, 1012]) {
      expect(statusAfterClose(code)).toEqual({ connected: false, closed: false });
    }
  });
});

describe("reconnectPillVisible (the retry is visible)", () => {
  const base = { connected: false, closed: false, dead: false, restarting: false, isLoading: false };

  it("shows while the hook retries a 4004 refusal (socket down, not closed)", () => {
    expect(reconnectPillVisible(base)).toBe(true);
  });

  it("hides the moment the retried attach is connected again", () => {
    expect(reconnectPillVisible({ ...base, connected: true })).toBe(false);
  });

  it("stays hidden for every state the pill must never cover", () => {
    expect(reconnectPillVisible({ ...base, closed: true })).toBe(false);
    expect(reconnectPillVisible({ ...base, dead: true })).toBe(false);
    expect(reconnectPillVisible({ ...base, restarting: true })).toBe(false);
    expect(reconnectPillVisible({ ...base, isLoading: true })).toBe(false);
  });
});
