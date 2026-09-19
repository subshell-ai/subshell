import { describe, expect, it } from "bun:test";
import { ApiError, NetworkError } from "@internal/node-admin";
import { queryRetry, queryRetryDelay } from "@/lib/query-client";

const net = new NetworkError(new TypeError("Failed to fetch"));
const http404 = new ApiError(404, "gone");

describe("queryRetry", () => {
  it("retries network errors UNBOUNDED (so a long outage self-heals, never sticks)", () => {
    expect(queryRetry(0, net)).toBe(true);
    expect(queryRetry(60, net)).toBe(true);
    expect(queryRetry(10_000, net)).toBe(true); // no cap — recovery must not need a reload
  });
  it("HTTP errors keep failing fast: exactly one retry, as before", () => {
    expect(queryRetry(0, http404)).toBe(true);
    expect(queryRetry(1, http404)).toBe(false);
  });
  it("non-Error throwables are not network errors", () => {
    expect(queryRetry(0, "string failure")).toBe(true); // the single legacy retry
    expect(queryRetry(1, "string failure")).toBe(false);
  });
});

describe("queryRetryDelay", () => {
  it("backs off exponentially for network errors, capped at 15s, jittered within [half, ceiling]", () => {
    // Equal jitter: result is random in [ceiling/2, ceiling]. Assert the band
    // over samples rather than exact values.
    const band = (attempt: number, lo: number, hi: number) => {
      for (let i = 0; i < 50; i++) {
        const d = queryRetryDelay(attempt, net);
        expect(d).toBeGreaterThanOrEqual(lo);
        expect(d).toBeLessThanOrEqual(hi);
      }
    };
    band(0, 500, 1000);
    band(1, 1000, 2000);
    band(4, 7500, 15_000); // capped before 16s
    band(30, 7500, 15_000);
    // Jitter means retries do not all land on the same tick: not all samples equal.
    const samples = new Set(Array.from({ length: 20 }, () => queryRetryDelay(30, net)));
    expect(samples.size).toBeGreaterThan(1);
  });
  it("HTTP errors retry once, immediately after (the old default shape)", () => {
    expect(queryRetryDelay(0, http404)).toBe(1000);
  });
});
