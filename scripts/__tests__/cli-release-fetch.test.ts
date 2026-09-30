import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiHeaders,
  fetchReleaseBytes,
  fetchReleaseIndex,
  MAX_ASSET_BYTES,
  releaseIndexFrom,
  releaseTag,
  releaseTagUrl,
} from "../cli-release-fetch";

/**
 * The desktop bundles fetch the CLI's own release binary as their sidecar
 * (cut order, 2026-09-30), over the GitHub API because the linux shard's
 * container carries no gh. These pins are the URL shapes, the auth posture,
 * and the transport policy (retry-what, cap-what); the desktop suites add
 * injected stubs for the CALLER's branches, because a live fetch against a
 * real release has nothing to pin (any given version may be deleted) while
 * these rules are forever.
 */

/** A fake fetch answering the queued responses in order, recording calls. */
function fakeFetch(...responses: Response[]): { fn: typeof fetch; calls: () => number } {
  let calls = 0;
  const fn = (async () => {
    const res = responses[Math.min(calls++, responses.length - 1)];
    // A Response body is single-use; every queued answer must survive one read.
    return res.clone();
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

function withToken<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "tok";
  return fn().finally(() => {
    if (saved === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = saved;
  });
}

describe("cli-release-fetch", () => {
  test("the tag and URL name the component's release, prefix carrying the -v", () => {
    expect(releaseTag("cli-server", "1.7.0")).toBe("cli-server-v1.7.0");
    expect(releaseTag("cli-node", "1.4.0")).toBe("cli-node-v1.4.0");
    expect(releaseTagUrl("cli-server", "1.7.0")).toBe(
      "https://api.github.com/repos/subshell-ai/subshell/releases/tags/cli-server-v1.7.0?per_page=100",
    );
  });

  test("per_page governs the asset page too", () => {
    // A CLI release carries 4×(binary + .sha256) + manifest + sig today,
    // comfortably under the API's default 30-asset page; the pin is that an
    // asset added tomorrow must not silently "not exist" at the page tail.
    expect(releaseTagUrl("cli-node", "1.0.0")).toContain("per_page=100");
  });

  test("the index mapper: only a 200 indexes, and draft is read exactly", () => {
    expect(releaseIndexFrom(404, { assets: [{ name: "x", url: "u" }], draft: true })).toEqual({
      status: 404,
      assets: {},
      draft: true,
    });
    expect(releaseIndexFrom(200, { assets: [{ name: "x", url: "u" }] })).toEqual({
      status: 200,
      assets: { x: "u" },
      draft: false,
    });
    expect(releaseIndexFrom(200, { draft: true }).draft).toBe(true);
  });

  test("the index fetch refuses outright when GH_TOKEN is absent", async () => {
    // The throw must land BEFORE any request: the private repo answers 404
    // unauthenticated, and a silent 404 reads as "not published yet", which
    // is a lie about the cause. No fetch may even be attempted.
    const saved = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      await expect(fetchReleaseIndex("cli-server", "1.0.0")).rejects.toThrow(/GH_TOKEN is not set/);
      // The bytes fetch guards identically: an empty bearer is a guaranteed
      // 401 that would read as a token problem, not as the missing token.
      await expect(fetchReleaseBytes("https://example.test/a")).rejects.toThrow(/GH_TOKEN is not set/);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
    }
  });

  test("requests are authenticated and versioned; downloads ask for octet-stream", () => {
    const json = apiHeaders("tok");
    expect(json.Authorization).toBe("Bearer tok");
    expect(json.Accept).toBe("application/vnd.github+json");
    expect(json["User-Agent"]).toBe("subshell-release-fetch");
    expect(apiHeaders("tok", true).Accept).toBe("application/octet-stream");
  });

  test("a transient blip is retried; the eventual answer decides", async () => {
    // GitHub answers secondary rate limiting as 403/429 (docs) and blips as
    // 5xx; a mid-cut 502 must not strand a 90-minute desktop shard on the
    // caller's soft "answered the release lookup with HTTP 502" refusal.
    const ff = fakeFetch(
      new Response(null, { status: 502 }),
      new Response(null, { status: 403, headers: { "retry-after": "1" } }),
      jsonResponse(200, { assets: [{ name: "b", url: "u" }] }),
    );
    const waits: number[] = [];
    const index = await withToken(() =>
      fetchReleaseIndex("cli-server", "1.7.0", { fetchFn: ff.fn, wait: async (ms) => void waits.push(ms) }),
    );
    expect(index.status).toBe(200);
    expect(index.assets).toEqual({ b: "u" });
    expect(ff.calls()).toBe(3);
    // 2s exponential for the status-less 502, then the server's own 1s.
    expect(waits).toEqual([2000, 1000]);
  });

  test("a 404 is NEVER retried: it is the decisive fact, not a flake", async () => {
    const ff = fakeFetch(new Response(null, { status: 404 }));
    const index = await withToken(() =>
      fetchReleaseIndex("cli-server", "9.9.9", { fetchFn: ff.fn, wait: async () => {} }),
    );
    expect(index.status).toBe(404);
    expect(ff.calls()).toBe(1);
  });

  test("the retry budget is bounded, and the LAST status surfaces unchanged", async () => {
    // Four tries, three waits, then the real problem reaches the caller's
    // verbatim status line. The retry is for the blip, not the outage.
    const ff = fakeFetch(new Response(null, { status: 500 }));
    const waits: number[] = [];
    const index = await withToken(() =>
      fetchReleaseIndex("cli-server", "1.7.0", { fetchFn: ff.fn, wait: async (ms) => void waits.push(ms) }),
    );
    expect(index.status).toBe(500);
    expect(ff.calls()).toBe(4);
    expect(waits.length).toBe(3);
  });

  test("Retry-After is honored but capped", async () => {
    // One absurd header must not stall a cut past the job timeout.
    const ff = fakeFetch(
      new Response(null, { status: 403, headers: { "retry-after": "100000000" } }),
      jsonResponse(200, {}),
    );
    const waits: number[] = [];
    await withToken(() =>
      fetchReleaseIndex("cli-server", "1.7.0", { fetchFn: ff.fn, wait: async (ms) => void waits.push(ms) }),
    );
    expect(waits).toEqual([60000]);
  });

  test("bytes are read whole and exact", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const ff = fakeFetch(new Response(payload, { status: 200 }));
    const got = await withToken(() => fetchReleaseBytes("https://example.test/a", { fetchFn: ff.fn }));
    expect(got.status).toBe(200);
    expect(Array.from(got.bytes ?? [])).toEqual([1, 2, 3, 4]);
  });

  test("an over-declared size is refused before the body is read", async () => {
    // content-length on the constructed Response: undici keeps a declared
    // header for a null body, and readBounded must trust it early.
    const ff = fakeFetch(new Response(null, { status: 200, headers: { "content-length": "1000" } }));
    await expect(
      withToken(() => fetchReleaseBytes("https://example.test/a", { fetchFn: ff.fn, maxBytes: 16 })),
    ).rejects.toThrow(/declares 1000 bytes/);
  });

  test("a stream that outgrows the cap is cancelled mid-read, not buffered", async () => {
    // The lying-content-length case: the meter is the ACTUAL byte count.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.enqueue(new Uint8Array(8));
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    });
    const ff = fakeFetch(new Response(stream, { status: 200 }));
    await expect(
      withToken(() => fetchReleaseBytes("https://example.test/a", { fetchFn: ff.fn, maxBytes: 16 })),
    ).rejects.toThrow(/stream passed 24 bytes/);
  });

  test("the cap matches the server's artifact ceiling", () => {
    // Two roads, one asset: apps/server/api/src/services/releases.ts refuses
    // the same downloads over 300 MiB. If one moves, both must.
    expect(MAX_ASSET_BYTES).toBe(300 * 1024 * 1024);
    const serverCap = readFileSync(join(import.meta.dir, "../../apps/server/api/src/services/releases.ts"), "utf8");
    const m = /export const MAX_ARTIFACT_BYTES = ([^;]+);/.exec(serverCap);
    expect(m?.[1]).toBe("300 * 1024 * 1024");
  });
});
