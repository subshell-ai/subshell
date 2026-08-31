import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { Elysia } from "elysia";

/** Vite pollutes asset hashes with `.chunk-` / `.umd.cjs` names; this plugin
 * serves values based on their final extension, so the map only needs the
 * content types that actually occur in the bundled output. */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

/** Marker used to re-export the static plugin for tests and docs. */
const STATIC_PLUGIN_NAME = "mote-static";

/**
 * Minimal static file server for the built SPA, replacing `@elysiajs/static`
 * which registers zero routes when running under Bun with Elysia 1.4.x.
 *
 * - `/` and `/index.html` resolve to the SPA shell; other dotted paths serve
 *   an existing file from the dist root (traversal-guarded) or 404
 * - `/assets/*` serves the built, content-hashed files with a `Cache-Control`
 *   header derived from the extension
 * - any other dotted top-level path (e.g. `/manifest.webmanifest`,
 *   `/icons/*.png`) is served from the dist root when the file exists there,
 *   otherwise 404 — same traversal guard as `/assets/*`
 * - any other top-level path (SPA route, e.g. `/profiles`) falls back to
 *   `index.html` so client-side routing can take over
 *
 * API routes (`/api/*`) are intentionally NOT handled here — they are
 * registered on the main app before this plugin and take precedence.
 *
 * @param root - Absolute path to the built frontend directory (`dist/`)
 */
export function staticPlugin(root: string) {
  const indexHtmlPath = join(root, "index.html");
  // Assets are content-hashed and safe to cache forever; index.html is
  // replaced wholesale by the next build, so its bytes are re-read whenever
  // the file changes — a frontend rebuild then takes effect without
  // restarting the server. The existence check stays at boot so a missing
  // build fails loudly here, not as a 500 on the first request.
  if (!existsSync(indexHtmlPath)) {
    throw new Error(`static plugin: built frontend not found at ${indexHtmlPath} — run the frontend build first`, {
      cause: new Error(indexHtmlPath),
    });
  }
  let shell: { body: Uint8Array; mtimeMs: number; size: number } | null = null;
  const currentIndexHtml = (): Uint8Array => {
    try {
      const stat = statSync(indexHtmlPath);
      if (!shell || shell.mtimeMs !== stat.mtimeMs || shell.size !== stat.size) {
        shell = { body: readFileSync(indexHtmlPath), mtimeMs: stat.mtimeMs, size: stat.size };
      }
    } catch {
      // Vanished mid-request — serve the last good bytes if there are any.
      if (shell) return shell.body;
      throw new Error(`static plugin: built frontend vanished at ${indexHtmlPath}`);
    }
    return shell.body;
  };

  // Vite emits files as `Content-hash.ext`; the hash does not change between
  // builds, so caching by name is sufficient. Values cached in an internal
  // map before the response is created, so multiple requests for the same
  // asset do not read the file again.
  const assetCache = new Map<string, { body: Uint8Array; ext: string }>();

  // The shell is the one file whose URL never changes, so it must revalidate
  // on every load — otherwise a rebuild's new hashed assets are invisible to
  // open browsers for the cache window. `private` keeps shared caches from
  // storing one user's shell for another.
  const htmlHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" };

  const app = new Elysia({ name: STATIC_PLUGIN_NAME })
    .get("/", () => {
      return new Response(currentIndexHtml(), { headers: htmlHeaders });
    })
    .get("/index.html", () => {
      return new Response(currentIndexHtml(), { headers: htmlHeaders });
    })
    .get("/assets/*", ({ params }) => {
      // params["*"] is the decoded path; normalize strips any traversal.
      const rel = normalize(params["*"]);
      // decodeURIComponent may throw on malformed input — treat as 404.
      let decoded: string;
      try {
        decoded = decodeURIComponent(rel);
      } catch {
        return new Response("not found", { status: 404 });
      }
      // params["*"] holds only the part after `/assets/`; re-attach the prefix.
      const filePath = join(root, "assets", decoded);
      // Guard: the resolved path must stay inside the dist root. `join`
      // normalizes `..` segments, so `..` trailing segments resolve *inside*
      // the root (e.g. .../dist/assets/.. → .../dist/assets) — reads then
      // target files or fail. The `+ sep` prefix check keeps any absolute
      // path or rooted `..` climb out.
      if (!filePath.startsWith(root + sep)) {
        return new Response("not found", { status: 404 });
      }
      let cached = assetCache.get(filePath);
      if (!cached) {
        // readFileSync throws on directories (EISDIR) and missing files
        // (ENOENT). existsSync pre-checks the common case; the catch turns
        // everything else (directory paths, permission errors) into a plain
        // 404 instead of leaking the raw error.
        if (!existsSync(filePath)) return new Response("not found", { status: 404 });
        const ext = filePath.match(/\.[a-z0-9]+$/i)?.[0] ?? "";
        try {
          cached = { body: readFileSync(filePath), ext };
        } catch {
          return new Response("not found", { status: 404 });
        }
        assetCache.set(filePath, cached);
      }
      const contentType = CONTENT_TYPES[cached.ext] ?? "application/octet-stream";
      const cacheControl = /\.(js|mjs|css)$/.test(cached.ext)
        ? "public, max-age=604800, immutable"
        : "public, max-age=3600";
      // Hashed asset names are unique per content, so the immutable window is
      // safe; content types are keyed off the final extension so the strict
      // map above stays small.
      return new Response(cached.body, { headers: { "Content-Type": contentType, "Cache-Control": cacheControl } });
    })
    // SPA fallback: any other top-level GET route → index.html — EXCEPT
    // dotted paths, which are files: serve them when they actually exist
    // inside dist/ (manifest.webmanifest, favicon.ico, icons/*), otherwise
    // 404. Same traversal guard as /assets/*.
    .get("*", ({ request }) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
      if (pathname.includes(".")) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(pathname);
        } catch {
          return new Response("not found", { status: 404 });
        }
        const rel = normalize(decoded.replace(/^\//, ""));
        // Reject escapes outright instead of relying on ENOENT: a `..` segment must
        // never reach the filesystem, even if dist/ contained a symlink back out.
        if (rel.split(sep).includes("..") || rel.startsWith("..")) {
          return new Response("not found", { status: 404 });
        }
        const filePath = join(root, rel);
        if (!filePath.startsWith(root + sep)) return new Response("not found", { status: 404 });
        const ext = filePath.match(/\.[a-z0-9]+$/i)?.[0] ?? "";
        let body: Uint8Array;
        try {
          body = readFileSync(filePath);
        } catch {
          return new Response("not found", { status: 404 });
        }
        return new Response(body, {
          headers: {
            "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
            // Root files are unhashed; a rebuild may replace them in place.
            // Service workers additionally get no-cache: default
            // updateViaCache routes their importScripts through the HTTP
            // cache, so a cached sw-handlers.js could pair a NEW sw.js
            // with OLD handlers after a deploy (breaks pushes for ≤ the
            // cache lifetime). The browser's own update check bypasses
            // HTTP caching anyway — freshness only costs a re-read here.
            "Cache-Control": rel.startsWith("sw") && /\.js$/.test(rel) ? "no-cache" : "public, max-age=3600",
          },
        });
      }
      if (!acceptsHtml) {
        // JSON APIs are never HTML; a 404 is fine for them.
        return new Response("not found", { status: 404 });
      }
      return new Response(currentIndexHtml(), { headers: htmlHeaders });
    });

  return app;
}
