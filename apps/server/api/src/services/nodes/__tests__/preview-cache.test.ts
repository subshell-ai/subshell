import { describe, expect, it } from "bun:test";
import {
  LOCAL_PREVIEW_TTL_MS,
  PREVIEW_CACHE_TTL_MS,
  previewCacheDrop,
  previewCacheGet,
  previewCachePut,
  resetPreviewCacheForTests,
} from "@/services/nodes/preview-cache.js";

describe("preview-cache", () => {
  it("put/get round-trips per id; unknown ids miss", () => {
    resetPreviewCacheForTests();
    previewCachePut("s1", ["a", "b"]);
    expect(previewCacheGet("s1", 1000)).toEqual(["a", "b"]);
    expect(previewCacheGet("s2", 1000)).toBeUndefined();
  });

  it("a newer put replaces the older screen", () => {
    resetPreviewCacheForTests();
    previewCachePut("s1", ["old"]);
    previewCachePut("s1", ["new"]);
    expect(previewCacheGet("s1", 1000)).toEqual(["new"]);
  });

  it("expiry-on-read: TTL-or-fresher hits, older misses (injected clock)", () => {
    resetPreviewCacheForTests();
    previewCachePut("s1", ["x"]); // stamped at real Date.now()
    const now = Date.now();
    expect(previewCacheGet("s1", now + PREVIEW_CACHE_TTL_MS - 1)).toEqual(["x"]);
    expect(previewCacheGet("s1", now + PREVIEW_CACHE_TTL_MS + 1)).toBeUndefined();
    // Expired-once stays gone: the read dropped it.
    expect(previewCacheGet("s1", now + PREVIEW_CACHE_TTL_MS + 2)).toBeUndefined();
  });

  it("drop removes one entry without disturbing the others", () => {
    resetPreviewCacheForTests();
    previewCachePut("s1", ["a"]);
    previewCachePut("s2", ["b"]);
    previewCacheDrop("s1");
    expect(previewCacheGet("s1", 1000)).toBeUndefined();
    expect(previewCacheGet("s2", 1000)).toEqual(["b"]);
  });

  it("TTL is 60 s (the sweep's cadence)", () => {
    expect(PREVIEW_CACHE_TTL_MS).toBe(60_000);
  });

  it("per-entry TTL: a short-TTL entry expires while a default entry survives", () => {
    resetPreviewCacheForTests();
    previewCachePut("local", ["x"], LOCAL_PREVIEW_TTL_MS);
    previewCachePut("agent", ["y"]); // default = the sweep's cadence
    const now = Date.now();
    expect(previewCacheGet("local", now + LOCAL_PREVIEW_TTL_MS - 1)).toEqual(["x"]);
    expect(previewCacheGet("local", now + LOCAL_PREVIEW_TTL_MS + 1)).toBeUndefined();
    // The agent entry outlives the local one's window, and expires on its
    // own — one writer's cadence must not shorten another's.
    expect(previewCacheGet("agent", now + LOCAL_PREVIEW_TTL_MS + 1)).toEqual(["y"]);
    expect(previewCacheGet("agent", now + PREVIEW_CACHE_TTL_MS + 1)).toBeUndefined();
  });
});
