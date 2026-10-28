import { expect, it } from "bun:test";
import { probeWebsite } from "./website-probe.js";

it("discovers HTML and same-port redirects, excluding APIs, downloads, and off-port redirects", async () => {
  let mode = "html";
  let offPortRequests = 0;
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
      if (new URL(request.url).pathname === "/login")
        return new Response("<h1>Sign in</h1>", { headers: { "content-type": "text/html" } });
      if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "/login" } });
      if (mode === "external") return Response.redirect(`http://127.0.0.1:${other.port}/`);
      if (mode === "loop") return new Response(null, { status: 302, headers: { location: "/" } });
      if (mode === "svg")
        return new Response("<svg><title>Icon only</title></svg>", { headers: { "content-type": "text/html" } });
      if (mode === "json") return Response.json({ ok: true });
      if (mode === "missing") return new Response("not found", { status: 404 });
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
    mode = "svg";
    expect(await probeWebsite(server.port as number, AbortSignal.timeout(1000))).toEqual({});
    expect(await probeWebsite(server.port as number, AbortSignal.abort())).toBeNull();
  } finally {
    server.stop(true);
    other.stop(true);
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
