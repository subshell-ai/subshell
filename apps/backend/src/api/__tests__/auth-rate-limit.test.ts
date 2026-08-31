import { describe, expect, it } from "bun:test";
import { authDelayForAttempts, maxAuthBackoffMs, normalizeAuthEmail } from "@/api/auth-rate-limit.route.js";

describe("auth-rate-limit math", () => {
  it("returns 0ms delay when there are no recorded attempts", () => {
    expect(authDelayForAttempts(0)).toBe(0);
    expect(authDelayForAttempts(undefined)).toBe(0);
  });
  it("doubles the delay per recorded attempt (2^n seconds, n = attempts)", () => {
    expect(authDelayForAttempts(0)).toBe(0);
    expect(authDelayForAttempts(1)).toBe(2_000);
    expect(authDelayForAttempts(2)).toBe(4_000);
    expect(authDelayForAttempts(3)).toBe(8_000);
  });
  it("caps the delay at 30 seconds", () => {
    expect(authDelayForAttempts(5)).toBe(30_000);
    expect(authDelayForAttempts(5)).toBe(maxAuthBackoffMs);
    expect(authDelayForAttempts(10)).toBe(30_000);
  });
  it("normalizes email to lowercase", () => {
    expect(normalizeAuthEmail("  Admin@Mote.Local ")).toBe("admin@mote.local");
    expect(normalizeAuthEmail(undefined)).toBe("");
  });
});
