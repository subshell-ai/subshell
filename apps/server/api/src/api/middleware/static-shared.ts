/**
 * Shared serving contract for BOTH static modes — the disk `staticPlugin`
 * and the memory `embeddedStaticPlugin` (spec 2026-09-03 §4 mandates that the
 * memory mode reuse the disk mode's content-type map and cache-control
 * classes, so they live here instead of being duplicated in the plugin file).
 */

/**
 * Cache headers for the SPA shell (`index.html`). The shell is the one file
 * whose URL never changes, so it must revalidate on every load — otherwise a
 * rebuild's new hashed assets are invisible to open browsers for the cache
 * window. `private` keeps shared caches from storing one user's shell for
 * another.
 */
export const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" };

/** Vite pollutes asset hashes with `.chunk-` / `.umd.cjs` names; the static
 * plugins serve values based on their final extension, so the map only needs
 * the content types that actually occur in the bundled output. */
export const CONTENT_TYPES: Record<string, string> = {
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

/** Final extension of a path/file name (`.webmanifest`, `.js`), or "" when absent. */
export function extOf(path: string): string {
  return path.match(/\.[a-z0-9]+$/i)?.[0] ?? "";
}

/** Content type for an extension; unknown extensions stream as opaque bytes. */
export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * `/assets/*` are content-hashed and safe to cache forever (the hash changes
 * with the bytes, so a stale hit is impossible); the immutable window applies
 * to the executable/text classes, everything else gets the 1 h default.
 */
export function assetCacheControl(ext: string): string {
  return /\.(js|mjs|css)$/.test(ext) ? "public, max-age=604800, immutable" : "public, max-age=3600";
}

/**
 * Cache class for unhashed dist-ROOT files (manifest, icons, service
 * workers): a rebuild may replace them in place, so a short public window.
 * Service workers additionally get no-cache: default updateViaCache routes
 * their importScripts through the HTTP cache, so a cached sw-handlers.js
 * could pair a NEW sw.js with OLD handlers after a deploy (breaks pushes for
 * ≤ the cache lifetime). The browser's own update check bypasses HTTP caching
 * anyway — freshness only costs a re-read here.
 */
export function rootFileCacheControl(rel: string): string {
  return rel.startsWith("sw") && /\.js$/.test(rel) ? "no-cache" : "public, max-age=3600";
}

/** The uniform 404 both static modes return for every miss. */
export function notFound(): Response {
  return new Response("not found", { status: 404 });
}
