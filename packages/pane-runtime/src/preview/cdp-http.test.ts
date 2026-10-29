import { describe, expect, it } from "bun:test";
import { fetchCdpJson, fetchCdpJsonFromLoopback } from "./cdp-http.js";

/** A `fetch` that scripts each loopback family, so the ladder is testable without binding ports. */
function scriptedFetch(byHost: Record<string, () => Response | Promise<Response>>): {
  fetchImpl: typeof fetch;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    fetchImpl: (async (input: string | URL) => {
      const url = String(input);
      asked.push(url);
      const host = url.includes("[::1]") ? "::1" : "127.0.0.1";
      const handler = byHost[host];
      if (!handler) throw new TypeError(`connect ECONNREFUSED ${host}`);
      return handler();
    }) as unknown as typeof fetch,
  };
}

describe("CDP HTTP discovery boundaries", () => {
  it("refuses redirects without contacting the redirected destination", async () => {
    let reached = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        reached++;
        return Response.json({ Browser: "foreign" });
      },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.redirect(`http://127.0.0.1:${target.port}/private`, 302);
      },
    });
    try {
      await expect(
        fetchCdpJson(`http://127.0.0.1:${source.port}/json/version`, AbortSignal.timeout(1000)),
      ).rejects.toThrow();
      expect(reached).toBe(0);
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });
  it("bounds discovery responses before JSON parsing", async () => {
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(`"${"x".repeat(256 * 1024)}"`);
      },
    });
    try {
      await expect(
        fetchCdpJson(`http://127.0.0.1:${source.port}/json/list`, AbortSignal.timeout(1000)),
      ).rejects.toThrow("exceeds 256 KiB");
    } finally {
      source.stop(true);
    }
  });
  it("aborts an unanswered discovery request", async () => {
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Promise<Response>(() => {});
      },
    });
    const controller = new AbortController();
    try {
      const outcome = fetchCdpJson(`http://127.0.0.1:${source.port}/json/list`, controller.signal);
      controller.abort();
      await expect(outcome).rejects.toThrow();
    } finally {
      source.stop(true);
    }
  });
});

describe("the loopback family ladder", () => {
  const signal = () => AbortSignal.timeout(2_000);

  it("asks IPv6 when IPv4 has no socket, so a browser bound to ::1 is still found", async () => {
    // The failure this pins: discovery listed an IPv6-only devtools endpoint's
    // port as a website but never as a browser to watch, because the probe knew
    // only 127.0.0.1.
    const f = scriptedFetch({ "::1": () => Response.json({ Browser: "v6-only Chrome" }) });
    const body = await fetchCdpJsonFromLoopback(9333, "/json/version", signal(), { fetchImpl: f.fetchImpl });
    expect(body).toEqual({ Browser: "v6-only Chrome" });
    expect(f.asked).toEqual(["http://127.0.0.1:9333/json/version", "http://[::1]:9333/json/version"]);
  });

  it("treats an IPv4 non-200 as no answer, since the two families are different sockets", async () => {
    const f = scriptedFetch({
      "127.0.0.1": () => new Response("nope", { status: 404 }),
      "::1": () => Response.json({ Browser: "real" }),
    });
    await expect(
      fetchCdpJsonFromLoopback(9333, "/json/version", signal(), { fetchImpl: f.fetchImpl }),
    ).resolves.toEqual({ Browser: "real" });
  });

  it("continues to IPv6 when IPv4's JSON is not a CDP document", async () => {
    const f = scriptedFetch({
      "127.0.0.1": () => Response.json({ status: "ok" }),
      "::1": () => Response.json({ Browser: "Chrome" }),
    });
    expect(
      await fetchCdpJsonFromLoopback(9333, "/json/version", signal(), {
        fetchImpl: f.fetchImpl,
        accept: (body) => typeof body === "object" && body !== null && "Browser" in body,
      }),
    ).toEqual({ Browser: "Chrome" });
    expect(f.asked).toHaveLength(2);
  });

  it("asks only IPv4 when it answers, leaving the common path one fetch", async () => {
    const f = scriptedFetch({ "127.0.0.1": () => Response.json({ Browser: "v4" }) });
    await fetchCdpJsonFromLoopback(9333, "/json/version", signal(), { fetchImpl: f.fetchImpl });
    expect(f.asked).toEqual(["http://127.0.0.1:9333/json/version"]);
  });

  it("hands a stalled IPv4 family to IPv6 instead of letting it spend the caller's budget", async () => {
    // The per-family slice is the whole reason an IPv6-only devtools endpoint
    // behind a wedged IPv4 listener is still watchable: without it the stalled
    // family drains the caller's deadline, the early-out treats that as the
    // caller giving up, and `::1` is never asked at all. The outer signal is
    // deliberately far longer than the slice, so only the slice can move this
    // port along.
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (!url.includes("[::1]")) {
        const signal = init?.signal;
        if (!signal) throw new Error("a family must be asked on its own slice");
        await new Promise<void>((_resolve, reject) => {
          const stop = (): void => reject(signal.reason);
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        });
        throw new Error("unreachable: a stalled family never answers");
      }
      return Response.json({ Browser: "v6 behind a stall" });
    }) as unknown as typeof fetch;
    const body = await fetchCdpJsonFromLoopback(9334, "/json/version", AbortSignal.timeout(4_000), {
      perFamilyTimeoutMs: 150,
      fetchImpl,
    });
    expect(body).toEqual({ Browser: "v6 behind a stall" });
    expect(asked).toEqual(["http://127.0.0.1:9334/json/version", "http://[::1]:9334/json/version"]);
  });

  it("reports the last failure when neither family answers", async () => {
    const f = scriptedFetch({});
    await expect(fetchCdpJsonFromLoopback(9333, "/json/version", signal(), { fetchImpl: f.fetchImpl })).rejects.toThrow(
      TypeError,
    );
    expect(f.asked).toHaveLength(2);
  });

  it("stops asking once the caller has given up", async () => {
    // The scan's budget or the handshake's death is an answer of its own:
    // continuing to the next family would only delay the caller's cleanup.
    const f = scriptedFetch({ "::1": () => Response.json({ Browser: "unreachable" }) });
    const dead = AbortSignal.abort();
    await expect(fetchCdpJsonFromLoopback(9333, "/json/version", dead, { fetchImpl: f.fetchImpl })).rejects.toThrow();
    expect(f.asked).toEqual(["http://127.0.0.1:9333/json/version"]);
  });

  it("carries the caller's abort into a family that is still stalled", async () => {
    // The case the two slice tests leave open: the family's window is COMPOSED
    // with the caller's signal, not a substitute for it. Replace the composition
    // with a bare per-family timer and a scan that has already given up still
    // waits out the whole slice before the early-out notices, so a dead scan
    // keeps a socket in flight. The slice here is far longer than the bound, so
    // only the caller's abort can end this quickly.
    const asked: string[] = [];
    const controller = new AbortController();
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      asked.push(String(input));
      const familySignal = init?.signal;
      if (!familySignal) throw new Error("a family must feel both its slice and its caller");
      await new Promise<void>((_resolve, reject) => {
        const stop = (): void => reject(familySignal.reason);
        if (familySignal.aborted) stop();
        else familySignal.addEventListener("abort", stop, { once: true });
      });
      throw new Error("unreachable: the caller gave up, not the family");
    }) as unknown as typeof fetch;
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 30);
    await expect(
      fetchCdpJsonFromLoopback(9337, "/json/version", controller.signal, { perFamilyTimeoutMs: 3_000, fetchImpl }),
    ).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(asked).toEqual(["http://127.0.0.1:9337/json/version"]);
  });
});
