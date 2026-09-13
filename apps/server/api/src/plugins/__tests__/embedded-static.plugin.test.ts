import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { embeddedStaticPlugin } from "@/plugins/static.plugin.js";

/**
 * Memory-mode static plugin tests (spec 2026-09-03 §4). The fixture map has
 * the shape the embed generator emits: dist-relative POSIX keys → base64 of
 * the exact bytes. Routing contract must match the disk plugin's
 * static.plugin.test.ts (shell, /assets/*, dotted root files, SPA fallback,
 * traversal guard), plus a strong ETag per entry.
 */
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const SHELL = "<!doctype html><html><head><title>subshell</title></head><body></body></html>";

/** A binary value with deliberately invalid UTF-8 — must serve byte-exact. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0xc3, 0x28, 0x00, 0x42]);

/** Traversal bait: a real map entry one level "above" what any route should
 * reach by escaping — the `..` guard must refuse the request outright, not
 * rely on the key simply being absent. */
const FIXTURE: Record<string, string> = {
  "index.html": b64(SHELL),
  "assets/app.js": b64('console.log("hi");'),
  "assets/app.css": b64("body{color:red}"),
  "assets/logo.svg": b64("<svg></svg>"),
  "manifest.webmanifest": b64('{"name":"Subshell","display":"standalone"}'),
  "icons/icon-192.png": Buffer.from(PNG_BYTES).toString("base64"),
  // Service workers: must never be cached (same class as the disk plugin).
  "sw.js": b64("importScripts('/sw-handlers.js');"),
  "sw-handlers.js": b64("self.SubshellSw={};"),
  "dist-secret.txt": b64("secret"),
};

/** App under test: memory plugin composed with a representative API route. */
const app = new Elysia().use(embeddedStaticPlugin(FIXTURE)).get(
  "/api/auth/setup",
  () =>
    new Response(JSON.stringify({ configured: true }), {
      headers: { "content-type": "application/json" },
    }),
);

/** Helper: run a GET through the composed app. */
const get = (path: string, headers?: Record<string, string>) =>
  app.handle(new Request(`http://localhost${path}`, { headers }));

/** The strong ETag the plugin must serve for a byte value. */
const etagFor = (bytes: Uint8Array | string) =>
  `"${createHash("sha256")
    .update(Buffer.from(bytes as never))
    .digest("hex")}"`;

describe("embedded static plugin", () => {
  it("throws at boot when the map has no index.html (the shell is mandatory)", () => {
    expect(() => embeddedStaticPlugin({ "assets/app.js": "eA==" })).toThrow(/index\.html/);
    expect(() => embeddedStaticPlugin({})).toThrow(/index\.html/);
  });

  it("serves the SPA shell at / and /index.html with the disk-mode headers + ETag", async () => {
    for (const path of ["/", "/index.html"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(await res.text()).toContain("<title>subshell</title>");
      // Same ETag every time — computed once per entry, sha256 of the bytes.
      expect(res.headers.get("etag")).toBe(etagFor(SHELL));
    }
  });

  it("serves hashed assets with correct content types, cache classes and ETag", async () => {
    const js = await get("/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=604800, immutable");
    expect(js.headers.get("etag")).toBe(etagFor('console.log("hi");'));
    expect(await js.text()).toBe('console.log("hi");');

    const css = await get("/assets/app.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("public, max-age=604800, immutable");

    const svg = await get("/assets/logo.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    // Unhashed extensions keep the 1h class (same as disk mode).
    expect(svg.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("serves binary map values byte-identically (invalid UTF-8 survives base64 decode)", async () => {
    const res = await get("/icons/icon-192.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("falls back to index.html for SPA routes when the client accepts HTML", async () => {
    const res = await get("/presets", { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<title>subshell</title>");
  });

  it("returns 404 for non-HTML requests that match no entry", async () => {
    const res = await get("/unknown/api/path", { accept: "application/json" });
    expect(res.status).toBe(404);
  });

  it("does not shadow API routes", async () => {
    const res = await get("/api/auth/setup", { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("returns 404 for missing assets", async () => {
    const res = await get("/assets/nope.js");
    expect(res.status).toBe(404);
  });

  it("serves dist-root files (PWA manifest) with their content type", async () => {
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(manifest.headers.get("cache-control")).toContain("max-age=3600");
    expect(await manifest.text()).toContain("standalone");
  });

  it("serves embedded service workers no-cache while other root files keep the 1h default", async () => {
    for (const file of ["sw.js", "sw-handlers.js"]) {
      const res = await get(`/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("404s dotted paths that are not in the map — even for HTML-seeking browsers", async () => {
    const res = await get("/missing.webmanifest", { accept: "text/html" });
    expect(res.status).toBe(404);
  });

  it("blocks traversal attempts before the map is consulted", async () => {
    // Encoded slashes and literal `..` segments survive WHATWG URL parsing,
    // so these reach the handler as genuine escape attempts — the guard must
    // reject them, not the accident of a missing key (dist-secret.txt IS a
    // real map entry a naive prefix-strip would serve).
    const viaSub = await get("/icons/..%2f..%2fdist-secret.txt");
    expect(viaSub.status).toBe(404);
    const viaAssets = await get("/assets/..%2f../dist-secret.txt");
    expect(viaAssets.status).toBe(404);
  });

  it("collapses encoded-dot climbs inside dist before routing (URL spec, same as disk mode)", async () => {
    // The URL parser decodes `%2e` and removes dot segments, so
    // `/%2e%2e/<file>` can never reach the handler as `../<file>` — it
    // arrives as a plain dist-root path, which disk mode would also serve if
    // the file were in the dist root. Nothing escapes, no 500 leaks.
    const res = await get("/%2e%2e/dist-secret.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("serves /assets/.. as the shell (URL parsing removes the dot segment, like disk mode)", async () => {
    const res = await get("/assets/..");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("reuses the same entry (body + ETag) across requests — decode/digest happen once", async () => {
    const a = await get("/assets/app.js");
    const b = await get("/assets/app.js");
    expect(a.headers.get("etag")).toBe(b.headers.get("etag"));
    expect(await a.text()).toBe(await b.text());
  });
});
