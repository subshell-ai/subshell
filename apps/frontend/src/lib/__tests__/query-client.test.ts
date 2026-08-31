import { describe, expect, it } from "bun:test";
import { ApiError, NetworkError } from "@/lib/api";
import { queryRetry, queryRetryDelay } from "@/lib/query-client";

const net = new NetworkError(new TypeError("Failed to fetch"));
const http404 = new ApiError(404, "gone");

describe("queryRetry", () => {
  it("retries network errors up to the cap (~60 attempts ride out a long outage)", () => {
    expect(queryRetry(0, net)).toBe(true);
    expect(queryRetry(59, net)).toBe(true);
    expect(queryRetry(60, net)).toBe(false);
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
  it("backs off exponentially for network errors, capped at 15s", () => {
    expect(queryRetryDelay(0, net)).toBe(1000);
    expect(queryRetryDelay(1, net)).toBe(2000);
    expect(queryRetryDelay(4, net)).toBe(15_000); // capped before 16s
    expect(queryRetryDelay(30, net)).toBe(15_000);
  });
  it("HTTP errors retry once, immediately after (the old default shape)", () => {
    expect(queryRetryDelay(0, http404)).toBe(1000);
  });
});
