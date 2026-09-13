import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { staticPlugin } from "@/plugins/static.plugin.js";

/**
 * Static plugin unit tests. Serves from a temp dir that mimics a Vite
 * build output (index.html + content-hashed assets).
 */
const root = mkdtempSync(join(tmpdir(), "subshell-static-test-"));

// Fixtures mimic a Vite build output. Written before the app is composed,
// because the plugin reads index.html eagerly at construction time.
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(
  join(root, "index.html"),
  "<!doctype html><html><head><title>subshell</title></head><body></body></html>",
);
writeFileSync(join(root, "assets/app.js"), 'console.log("hi");');
writeFileSync(join(root, "assets/app.css"), "body{color:red}");
writeFileSync(join(root, "assets/logo.svg"), "<svg></svg>");
mkdirSync(join(root, "icons"), { recursive: true });
writeFileSync(join(root, "manifest.webmanifest"), '{"name":"Subshell","display":"standalone"}');
writeFileSync(join(root, "icons/icon-192.png"), "PNGBYTES");
// Service workers: must never be cached (see the no-cache branch in the plugin).
writeFileSync(join(root, "sw.js"), "importScripts('/sw-handlers.js');");
writeFileSync(join(root, "sw-handlers.js"), "self.SubshellSw={};");

/** App under test: static plugin composed with a representative API route. */
const app = new Elysia().use(staticPlugin(root)).get(
  "/api/auth/setup",
  () =>
    new Response(JSON.stringify({ configured: true }), {
      headers: { "content-type": "application/json" },
    }),
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  // The traversal tests write their bait files one level ABOVE the temp root
  // (that is the point — they must be unreadable, not merely absent); the
  // sibling paths take the same `..` walk to reach.
  rmSync(join(root, "..", "outside.txt"), { force: true });
  rmSync(join(root, "..", "dist-secret.txt"), { force: true });
});

/** Helper: run a GET through the composed app. */
const get = (path: string, headers?: Record<string, string>) =>
  app.handle(new Request(`http://localhost${path}`, { headers }));

describe("static plugin", () => {
  it("serves the SPA shell at / and /index.html", async () => {
    for (const path of ["/", "/index.html"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("<title>subshell</title>");
    }
  });

  it("serves hashed assets with correct content types and cache headers", async () => {
    const js = await get("/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=604800, immutable");
    expect(await js.text()).toBe('console.log("hi");');

    const css = await get("/assets/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const svg = await get("/assets/logo.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("falls back to index.html for SPA routes when the client accepts HTML", async () => {
    const res = await get("/presets", { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<title>subshell</title>");
  });

  it("returns 404 for non-HTML requests that match no file", async () => {
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

  it("returns 404 for directory paths instead of leaking server errors", async () => {
    // `/assets/.` resolves to the assets *directory*; readFileSync would throw
    // EISDIR — the plugin must turn that into a plain 404, not a 500.
    const dot = await get("/assets/.");
    expect(dot.status).toBe(404);
    expect(await dot.text()).not.toContain("EISDIR");

    // `..` trailing segments normalize back inside the root; what gets served
    // is index.html (or 404), never a path outside the dist root.
    const up = await get("/assets/..");
    expect(up.status).toBe(200);
    expect(up.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves dist-root files (PWA manifest, icons) with their content type", async () => {
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifest.text()).toContain("standalone");
    const icon = await get("/icons/icon-192.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/png");
  });

  it("serves service workers no-cache while other root files keep the 1h default", async () => {
    // A cached sw-handlers.js can pair a NEW sw.js with OLD handlers after
    // a deploy (updateViaCache routes importScripts through the HTTP cache),
    // which breaks pushes for the cache lifetime — hence no-cache for sw*.js.
    for (const file of ["sw.js", "sw-handlers.js"]) {
      const res = await get(`/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("404s dotted paths that do not exist — even for HTML-seeking browsers", async () => {
    const res = await get("/missing.webmanifest", { accept: "text/html" });
    expect(res.status).toBe(404);
  });

  it("blocks traversal through dotted root paths", async () => {
    writeFileSync(join(root, "..", "outside.txt"), "secret");
    const res = await get("/%2e%2e/outside.txt");
    expect(res.status).toBe(404);
  });

  it("rejects .. segments in dotted paths before touching the filesystem", async () => {
    // A real file one level above dist/: every request below must be refused
    // by the guard, not by an accidental ENOENT — if dist/ ever contained a
    // symlink back out, ENOENT-based 404s would silently become 200s.
    writeFileSync(join(root, "..", "dist-secret.txt"), "secret");
    // Encoded slashes survive WHATWG URL parsing, so the `..` segments reach
    // the handler as genuine path components instead of being collapsed.
    const viaSub = await get("/icons/..%2f..%2fdist-secret.txt");
    expect(viaSub.status).toBe(404);
    const viaRoot = await get("/%2e%2e/dist-secret.txt");
    expect(viaRoot.status).toBe(404);
  });

  it("serves HTML with private cache headers", async () => {
    const res = await get("/", { accept: "text/html" });
    expect(res.headers.get("cache-control")).toBe("private, no-cache");

    // Hashed assets stay immutable-public for long-lived caching.
    const asset = await get("/assets/app.js");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=604800, immutable");
  });
});
