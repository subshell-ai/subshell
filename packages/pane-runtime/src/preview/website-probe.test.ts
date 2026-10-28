import { expect, it } from "bun:test";
import { probeWebsite } from "./website-probe.js";

it("discovers HTML and same-port redirects, excluding APIs, downloads, and off-port redirects", async () => {
  let mode = "html";
  let offPortRequests = 0;
  // A server that only answers document offers is the reason the probe asks
  // for more than one type, so what it offered is part of the contract.
  let lastAccept = "";
  const other = Bun.serve({
    port: 0,
    fetch: () => {
      offPortRequests++;
      return new Response("unexpected");
    },
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      lastAccept = request.headers.get("accept") ?? "";
      if (new URL(request.url).pathname === "/login")
        return new Response("<h1>Sign in</h1>", { headers: { "content-type": "text/html" } });
      if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "/login" } });
      if (mode === "external") return Response.redirect(`http://127.0.0.1:${other.port}/`);
      if (mode === "loop") return new Response(null, { status: 302, headers: { location: "/" } });
      if (mode === "svg")
        return new Response("<svg><title>Icon only</title></svg>", { headers: { "content-type": "text/html" } });
      if (mode === "json") return Response.json({ ok: true });
      if (mode === "missing") return new Response("not found", { status: 404 });
      // A browser paints this as HTML, so a site served this way is a site.
      if (mode === "xhtml")
        return new Response("<head><title>XHTML site</title></head><h1>Website</h1>", {
          headers: { "content-type": "application/xhtml+xml" },
        });
      // A type that merely starts with an accepted one is not that type.
      if (mode === "lookalike")
        return new Response("<title>not a page</title>", { headers: { "content-type": "text/html-fragment" } });
      return new Response(
        "<head><title>  My &amp; your &#x1f680; site </title></head><h1>Website</h1><svg><title>Icon label</title></svg>",
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...(mode === "download" ? { "content-disposition": "attachment" } : {}),
          },
        },
      );
    },
  });
  try {
    for (const [value, expected] of [
      ["html", true],
      ["redirect", true],
      ["xhtml", true],
      ["lookalike", false],
      ["json", false],
      ["missing", false],
      ["download", false],
      ["external", false],
      ["loop", false],
    ] as const) {
      mode = value;
      expect(Boolean(await probeWebsite(server.port as number, AbortSignal.timeout(1000)))).toBe(expected);
    }
    expect(offPortRequests).toBe(0);
    mode = "html";
    expect(await probeWebsite(server.port as number, AbortSignal.timeout(1000))).toEqual({
      title: "My & your 🚀 site",
    });
    mode = "xhtml";
    expect(await probeWebsite(server.port as number, AbortSignal.timeout(1000))).toEqual({ title: "XHTML site" });
    expect(lastAccept).toContain("application/xhtml+xml");
    mode = "svg";
    expect(await probeWebsite(server.port as number, AbortSignal.timeout(1000))).toEqual({});
    expect(await probeWebsite(server.port as number, AbortSignal.abort())).toBeNull();
  } finally {
    server.stop(true);
    other.stop(true);
  }
});

it("reaches an IPv6-only website when the IPv4 dial stalls", async () => {
  // The refused-socket case is covered by the test below; this is the meaner
  // one. A firewall DROP or a listener that accepts and never answers would,
  // under one shared per-port budget, spend all of it on the family that cannot
  // reply and leave a real IPv6-only site out of the picker. Stubbing fetch is
  // how the stall becomes deterministic without a firewall.
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (!url.includes("127.0.0.1"))
      return new Response("<title>V6 only</title>", { headers: { "content-type": "text/html" } });
    await new Promise<void>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("unreachable: a stalled dial never answers");
  }) as typeof fetch;
  try {
    // The outer budget is generous on purpose: it is the PER-FAMILY slice that
    // has to fire here, and a shared budget would ride this whole window out.
    expect(await probeWebsite(4199, AbortSignal.timeout(3_000))).toEqual({ title: "V6 only" });
    expect(asked).toEqual(["http://127.0.0.1:4199/", "http://[::1]:4199/"]);
  } finally {
    globalThis.fetch = real;
  }
});

it("asks both families before dropping a port, since two sockets share the number", async () => {
  // A tool bound to 127.0.0.1 while the dev server holds ::1 is a real
  // arrangement. The first family's "not a website" describes its own socket, so
  // discovery has to ask the second before it leaves the port out of the picker.
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    return url.includes("127.0.0.1")
      ? Response.json({ ok: true })
      : new Response("<title>V6 site</title>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    expect(await probeWebsite(4198, AbortSignal.timeout(3_000))).toEqual({ title: "V6 site" });
    expect(asked).toEqual(["http://127.0.0.1:4198/", "http://[::1]:4198/"]);
  } finally {
    globalThis.fetch = real;
  }
});

it("drops a port only after both families decline", async () => {
  const real = globalThis.fetch;
  let asks = 0;
  globalThis.fetch = (async (_input: string | URL) => {
    asks++;
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    expect(await probeWebsite(4197, AbortSignal.timeout(3_000))).toBeNull();
    expect(asks).toBe(2);
  } finally {
    globalThis.fetch = real;
  }
});

it("discovers an IPv6-only website using the forwarding loopback fallback", async () => {
  const server = Bun.serve({
    hostname: "::1",
    port: 0,
    fetch: () => new Response("<title>IPv6 app</title>", { headers: { "content-type": "text/html" } }),
  });
  try {
    expect(await probeWebsite(server.port as number, AbortSignal.timeout(1000))).toEqual({ title: "IPv6 app" });
  } finally {
    server.stop(true);
  }
});
