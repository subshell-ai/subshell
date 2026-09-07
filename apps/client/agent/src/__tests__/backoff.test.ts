import { expect, test } from "bun:test";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelay } from "../backoff.js";

test("full jitter at rand=1 hits the raw exponential exactly (deterministic)", () => {
  expect(backoffDelay(0, () => 1)).toBe(BACKOFF_BASE_MS); // 1 s
  expect(backoffDelay(1, () => 1)).toBe(2_000);
  expect(backoffDelay(5, () => 1)).toBe(32_000);
});

test("rand=0 never waits; fractional rand scales linearly", () => {
  expect(backoffDelay(0, () => 0)).toBe(0);
  expect(backoffDelay(9, () => 0)).toBe(0);
  expect(backoffDelay(4, () => 0.5)).toBe(8_000); // 0.5 * 16 s
  expect(backoffDelay(2, () => 0.25)).toBeCloseTo(1_000, 9); // 0.25 * 4 s
});

test("2**30 (and beyond) clamps to the 60 s cap", () => {
  // 1000 * 2**30 ≈ 1.07e12 ms — must clamp, not overflow the wait.
  expect(backoffDelay(30, () => 1)).toBe(BACKOFF_CAP_MS);
  expect(backoffDelay(45, () => 1)).toBe(BACKOFF_CAP_MS);
  // 2**1024 is Infinity in IEEE-754 — Math.min still yields the cap.
  expect(backoffDelay(1024, () => 1)).toBe(BACKOFF_CAP_MS);
  expect(backoffDelay(10_000, () => 0.5)).toBe(BACKOFF_CAP_MS * 0.5);
});

test("bounds: for every attempt and every draw, 0 <= delay <= min(cap, base * 2**a)", () => {
  for (let attempt = 0; attempt <= 14; attempt++) {
    const bound = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    for (const r of [0, 0.1, 0.5, 0.999999, 1]) {
      const d = backoffDelay(attempt, () => r);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(bound);
    }
  }
});

test("negative attempts floor to 0 (never below base delay)", () => {
  expect(backoffDelay(-3, () => 1)).toBe(BACKOFF_BASE_MS); // 2**max(0,-3) = 1
});

test("default rand (Math.random) stays within bounds across many draws", () => {
  for (let i = 0; i < 200; i++) {
    const d = backoffDelay(i % 12);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  }
});
