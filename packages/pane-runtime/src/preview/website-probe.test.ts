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

it("will not offer a v6 site whose port the lane cannot open past a stalled IPv4", async () => {
  // The refused-socket case is covered by the test below; this is the meaner
  // one, and the answer changed once the lane was read. forward.ts dials IPv4
  // first and retries `::1` only after a REFUSED connect, so a listener that
  // accepts on 127.0.0.1 and never answers holds the viewer's lane open on a
  // socket that produces nothing, however well the same port serves a page on
  // `::1`. Advertising that site would fill the picker with a row that can only
  // open into a hang, so a stalled IPv4 ends the question without asking IPv6.
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
    expect(await probeWebsite(4199, AbortSignal.timeout(3_000))).toBeNull();
    expect(asked).toEqual(["http://127.0.0.1:4199/"]);
  } finally {
    globalThis.fetch = real;
  }
});

it("does not advertise a port that only accepted and never answered", async () => {
  // The other side of the cold-server rule. A wedged database, a language server
  // or a leftover bind accepts the probe's GET / and says nothing back, and at
  // this distance it is indistinguishable from a dev server compiling its first
  // route. Offering it would fill the picker with rows that can never render,
  // which is the thing this feature exists to stop, so silence is not an answer.
  const real = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    await new Promise<void>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("unreachable");
  }) as unknown as typeof fetch;
  try {
    expect(await probeWebsite(4196, AbortSignal.timeout(6_000))).toBeNull();
  } finally {
    globalThis.fetch = real;
  }
});

it("still lists a dev server that answers late, which is a compiling one", async () => {
  // The case the rule above must not lose: the first request compiles the route,
  // so the answer is slow but real, and it lands inside the family's window.
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    if (!String(input).includes("127.0.0.1")) return new Response(null, { status: 400 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return new Response("<title>Compiling</title>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    expect(await probeWebsite(4192, AbortSignal.timeout(6_000))).toEqual({ title: "Compiling" });
  } finally {
    globalThis.fetch = real;
  }
});

it("keeps the verdict it already has when the scan's budget runs out mid-probe", async () => {
  // The first family answered with a real page and the second was still being
  // asked when the scan ended. Discarding the held answer here would drop a port
  // discovery had already established serves a website.
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    if (!String(input).includes("127.0.0.1")) {
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    }
    return new Response("<p>untitled page</p>", { headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  try {
    // Outer budget shorter than the per-family one, so the scan aborts while the
    // second family is being asked.
    expect(await probeWebsite(4194, AbortSignal.timeout(250))).toEqual({});
  } finally {
    globalThis.fetch = real;
  }
});

it("sends a client class servers accept, so a bot filter does not hide a site", async () => {
  const real = globalThis.fetch;
  let sent = "";
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    sent = String(new Headers(init?.headers).get("user-agent") ?? "");
    return new Response("<title>Internal tool</title>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    expect(await probeWebsite(4193, AbortSignal.timeout(2_000))).toEqual({ title: "Internal tool" });
    // Not a borrowed browser identity: it says what it is, in the shape servers
    // that gate on User-Agent will answer.
    expect(sent).toContain("Mozilla/5.0");
    expect(sent).toContain("SubshellPreviewProbe");
  } finally {
    globalThis.fetch = real;
  }
});

it("labels a port by the socket the lane will actually show, not the other family's title", async () => {
  // The row a person picks is painted by forward.ts's dial, and that dial stays
  // on 127.0.0.1 whenever the connect succeeds. A tool answering an untitled
  // page there is therefore what the frame will show, so borrowing the dev
  // server's title from `::1` would label the preview with a page nobody sees.
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    return url.includes("127.0.0.1")
      ? new Response("<p>untitled tool page</p>", { headers: { "content-type": "text/html" } })
      : new Response("<title>Dev server</title>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    expect(await probeWebsite(4195, AbortSignal.timeout(3_000))).toEqual({});
    expect(asked).toEqual(["http://127.0.0.1:4195/"]);
  } finally {
    globalThis.fetch = real;
  }
});

it("will not offer an API's IPv4 socket on a dev server's IPv6 behalf", async () => {
  // The arrangement is real (a tool bound to 127.0.0.1 while the dev server
  // holds `::1`) and it is the one this rule exists for: the lane connects to
  // IPv4, gets the API's JSON, and the frame shows that while the picker says
  // "V6 site". An IPv4 that ANSWERS settles the question, answer or no answer.
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
    expect(await probeWebsite(4198, AbortSignal.timeout(3_000))).toBeNull();
    expect(asked).toEqual(["http://127.0.0.1:4198/"]);
  } finally {
    globalThis.fetch = real;
  }
});

it("drops a port only after both families decline", async () => {
  // "Decline" means no socket answered at all: that is the one shape where the
  // lane would also walk to `::1`, so both families get asked before the port is
  // left out.
  const real = globalThis.fetch;
  let asks = 0;
  globalThis.fetch = (async () => {
    asks++;
    throw new TypeError("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
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
