import { beforeEach, describe, expect, it } from "bun:test";
import {
  clampSamplesPerSec,
  DEFAULT_MOTION_SAMPLES_PER_SEC,
  MAX_MOTION_SAMPLES_PER_SEC,
  MIN_MOTION_SAMPLES_PER_SEC,
  motionSampleIntervalMs,
  motionSamplesPerSec,
  setMotionSamplesPerSec,
} from "@/lib/mouse-sampling-pref";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* private mode */
  }
});

describe("mouse sampling preference", () => {
  it("defaults to 2 per second — one report every 500 ms", () => {
    expect(DEFAULT_MOTION_SAMPLES_PER_SEC).toBe(2);
    expect(motionSamplesPerSec()).toBe(2);
    expect(motionSampleIntervalMs()).toBe(500);
  });

  it("round-trips a chosen rate", () => {
    expect(setMotionSamplesPerSec(10)).toBe(10);
    expect(motionSamplesPerSec()).toBe(10);
    expect(motionSampleIntervalMs()).toBe(100);
  });

  /**
   * The floor is 1 rather than 0 deliberately: a drag that never reports reads
   * as the terminal ignoring the mouse, not as a performance setting.
   */
  it("clamps to the offered range and rounds", () => {
    expect(clampSamplesPerSec(0)).toBe(MIN_MOTION_SAMPLES_PER_SEC);
    expect(clampSamplesPerSec(-5)).toBe(MIN_MOTION_SAMPLES_PER_SEC);
    expect(clampSamplesPerSec(9999)).toBe(MAX_MOTION_SAMPLES_PER_SEC);
    expect(clampSamplesPerSec(2.4)).toBe(2);
  });

  it("treats a stored value that is not a number as no choice at all", () => {
    localStorage.setItem("subshell.mouseSamplesPerSec", "banana");
    expect(motionSamplesPerSec()).toBe(DEFAULT_MOTION_SAMPLES_PER_SEC);
    expect(clampSamplesPerSec(Number.NaN)).toBe(DEFAULT_MOTION_SAMPLES_PER_SEC);
  });

  it("clamps a hand-edited stored value on the way out", () => {
    localStorage.setItem("subshell.mouseSamplesPerSec", "10000");
    expect(motionSamplesPerSec()).toBe(MAX_MOTION_SAMPLES_PER_SEC);
  });
});
