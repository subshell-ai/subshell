import { describe, expect, it } from "bun:test";
import { fetchCdpJson } from "./cdp-http.js";

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
