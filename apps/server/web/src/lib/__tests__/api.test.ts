import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, apiFetch, isNetworkError, NetworkError } from "@internal/node-admin";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("apiFetch error classes", () => {
  it("wraps a rejected fetch in NetworkError (no HTTP answer at all)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await apiFetch("/api/anything").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(isNetworkError(err)).toBe(true);
  });

  it("HTTP failures stay ApiError — the server ANSWERED, it is reachable", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errId: "e1", code: "NOT_FOUND_ERROR", message: "gone", statusCode: 404 }), {
        status: 404,
      })) as unknown as typeof fetch;
    const err = await apiFetch("/api/anything").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isNetworkError(err)).toBe(false);
    expect((err as ApiError).status).toBe(404);
  });

  it("204 No Content resolves undefined — a body-less success is not a parse failure", async () => {
    // The ssh saved-host DELETE answers 204 with NO body (a 204 may not carry
    // one); parsing one is a throw, so the helper must return before it tries.
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await expect(apiFetch("/api/ssh/saved-hosts/x")).resolves.toBeUndefined();
  });

  it("isNetworkError matches only NetworkError (plain errors stay fail-fast)", () => {
    expect(isNetworkError(new NetworkError(new TypeError("x")))).toBe(true);
    expect(isNetworkError(new TypeError("x"))).toBe(false);
    expect(isNetworkError(new Error("boom"))).toBe(false);
  });
});
