import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { Elysia } from "elysia";
import { EMBEDDED_WEB } from "@/generated/embedded-web.js";
import {
  assetCacheControl,
  contentTypeFor,
  extOf,
  HTML_HEADERS,
  notFound,
  rootFileCacheControl,
} from "@/plugins/static-shared.js";

/** Marker used to re-export the static plugin for tests and docs. */
const STATIC_PLUGIN_NAME = "subshell-static";

/** Distinct plugin name for the memory mode so the two never dedupe against
 * each other (Elysia dedupes named plugins). */
const EMBEDDED_STATIC_PLUGIN_NAME = "subshell-static-embedded";

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
 * - any other top-level path (SPA route, e.g. `/presets`) falls back to
 *   `index.html` so client-side routing can take over
 *
 * API routes (`/api/*`) are intentionally NOT handled here — they are
 * registered on the main app before this plugin and take precedence.
 *
 * The content-type map and cache-control classes are shared with the memory
 * mode via `static-shared.ts`; behaviour of this factory is unchanged by that
 * split (spec 2026-09-03 §4 keeps disk deployments byte-identical).
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
    throw new Error(`static plugin: built frontend not found at ${indexHtmlPath}; run the frontend build first`, {
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

  const app = new Elysia({ name: STATIC_PLUGIN_NAME })
    .get("/", () => {
      return new Response(currentIndexHtml(), { headers: HTML_HEADERS });
    })
    .get("/index.html", () => {
      return new Response(currentIndexHtml(), { headers: HTML_HEADERS });
    })
    .get("/assets/*", ({ params }) => {
      // params["*"] is the decoded path; normalize strips any traversal.
      const rel = normalize(params["*"]);
      // decodeURIComponent may throw on malformed input — treat as 404.
      let decoded: string;
      try {
        decoded = decodeURIComponent(rel);
      } catch {
        return notFound();
      }
      // params["*"] holds only the part after `/assets/`; re-attach the prefix.
      const filePath = join(root, "assets", decoded);
      // Guard: the resolved path must stay inside the dist root. `join`
      // normalizes `..` segments, so `..` trailing segments resolve *inside*
      // the root (e.g. .../dist/assets/.. → .../dist/assets) — reads then
      // target files or fail. The `+ sep` prefix check keeps any absolute
      // path or rooted `..` climb out.
      if (!filePath.startsWith(root + sep)) {
        return notFound();
      }
      let cached = assetCache.get(filePath);
      if (!cached) {
        // readFileSync throws on directories (EISDIR) and missing files
        // (ENOENT). existsSync pre-checks the common case; the catch turns
        // everything else (directory paths, permission errors) into a plain
        // 404 instead of leaking the raw error.
        if (!existsSync(filePath)) return notFound();
        const ext = extOf(filePath);
        try {
          cached = { body: readFileSync(filePath), ext };
        } catch {
          return notFound();
        }
        assetCache.set(filePath, cached);
      }
      // Hashed asset names are unique per content, so the immutable window is
      // safe; content types are keyed off the final extension so the strict
      // shared map stays small.
      return new Response(cached.body, {
        headers: { "Content-Type": contentTypeFor(cached.ext), "Cache-Control": assetCacheControl(cached.ext) },
      });
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
          return notFound();
        }
        const rel = normalize(decoded.replace(/^\//, ""));
        // Reject escapes outright instead of relying on ENOENT: a `..` segment must
        // never reach the filesystem, even if dist/ contained a symlink back out.
        if (rel.split(sep).includes("..") || rel.startsWith("..")) {
          return notFound();
        }
        const filePath = join(root, rel);
        if (!filePath.startsWith(root + sep)) return notFound();
        const ext = extOf(filePath);
        let body: Uint8Array;
        try {
          body = readFileSync(filePath);
        } catch {
          return notFound();
        }
        return new Response(body, {
          headers: {
            "Content-Type": contentTypeFor(ext),
            // Root files are unhashed; sw*.js gets the no-cache class (see
            // rootFileCacheControl) — everything else the 1 h default.
            "Cache-Control": rootFileCacheControl(rel),
          },
        });
      }
      if (!acceptsHtml) {
        // JSON APIs are never HTML; a 404 is fine for them.
        return notFound();
      }
      return new Response(currentIndexHtml(), { headers: HTML_HEADERS });
    });

  return app;
}

/** A decoded, traversal-free, dist-relative POSIX path, or null if the raw
 * request path cannot be trusted (malformed encoding, `..` escape). */
function embeddedKey(prefix: string | null, raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const rel = normalize(decoded.replace(/^\/+/, ""));
  const segments = rel.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".");
  // Reject escapes before the map is consulted: keys are literal dist-relative
  // paths, and a `..` must never reach the lookup even if the map (or a
  // future prefix-stripping "fix") made the escape resolvable.
  if (segments.includes("..")) return null;
  const key = prefix === null ? segments.join("/") : [prefix, ...segments].join("/");
  return key === "" ? null : key;
}

/**
 * Memory-mode twin of {@link staticPlugin}: serves the SPA baked into the
 * binary by `scripts/embed-web.ts` (the `EMBEDDED_WEB` map of base64 values),
 * with the SAME routing contract — shell at `/` + `/index.html`, content-typed
 * `/assets/*`, dotted root files, SPA fallback, traversal guard, `/api/*`
 * untouched (spec 2026-09-03 §4). Every response additionally carries a
 * strong `ETag` (sha256 of the served bytes); values are base64-decoded and
 * digested once per entry on first use and cached thereafter.
 *
 * @param source - the dist-relative path → base64 map; defaults to the
 *   generated `EMBEDDED_WEB` (tests inject a fixture map through this param)
 */
export function embeddedStaticPlugin(source: Record<string, string> = EMBEDDED_WEB) {
  // The generator guarantees index.html at build time; re-assert at boot so a
  // mis-generated binary fails loudly here, not as a 500 on the first request
  // (the same contract the disk factory has on its dist dir).
  if (source["index.html"] === undefined) {
    throw new Error(
      "embedded static plugin: no embedded index.html in EMBEDDED_WEB; run scripts/embed-web.ts or serve the frontend from disk",
      {
        cause: new Error("index.html"),
      },
    );
  }
  // Base64 decode + sha256 digest are lazy per entry and cached forever:
  // embedded bytes never change under a running process.
  const entries = new Map<string, { body: Uint8Array; ext: string; etag: string }>();
  const entryFor = (key: string): { body: Uint8Array; ext: string; etag: string } => {
    let entry = entries.get(key);
    if (!entry) {
      const body = Buffer.from(source[key], "base64");
      const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
      entry = { body, ext: extOf(key), etag };
      entries.set(key, entry);
    }
    return entry;
  };

  const shellResponse = () => {
    const shell = entryFor("index.html");
    return new Response(shell.body, { headers: { ...HTML_HEADERS, ETag: shell.etag } });
  };
  const fileResponse = (key: string, cacheControl: string) => {
    const entry = entryFor(key);
    return new Response(entry.body, {
      headers: { "Content-Type": contentTypeFor(entry.ext), "Cache-Control": cacheControl, ETag: entry.etag },
    });
  };

  const app = new Elysia({ name: EMBEDDED_STATIC_PLUGIN_NAME })
    .get("/", shellResponse)
    .get("/index.html", shellResponse)
    .get("/assets/*", ({ params }) => {
      // params["*"] holds only the part after `/assets/`; re-attach the prefix.
      const key = embeddedKey("assets", params["*"]);
      if (key === null || source[key] === undefined) return notFound();
      return fileResponse(key, assetCacheControl(extOf(key)));
    })
    // SPA fallback: identical contract to the disk plugin's `*` route —
    // dotted paths are files (exact map lookup, traversal-guarded), everything
    // else falls back to the shell for HTML-seeking clients.
    .get("*", ({ request }) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
      if (pathname.includes(".")) {
        const key = embeddedKey(null, pathname);
        if (key === null || source[key] === undefined) return notFound();
        return fileResponse(key, rootFileCacheControl(key));
      }
      if (!acceptsHtml) {
        // JSON APIs are never HTML; a 404 is fine for them.
        return notFound();
      }
      return shellResponse();
    });

  return app;
}

/** Which SPA source {@link selectStaticPlugin} actually chose at boot. */
export type StaticSource = "disk" | "embedded" | "unselected";

/**
 * Recorded rather than recomputed. The choice is made ONCE at boot and cannot
 * change under a running process, while re-deriving it later would `existsSync`
 * a path that may have appeared or vanished since — reporting a source the
 * server is not actually serving from. `unselected` means boot never got here
 * (a test importing the module, or a failed selection).
 */
let chosenSource: StaticSource = "unselected";

/**
 * The SPA source this process is serving. Admin diagnostics only: a compiled
 * binary run from a repo checkout silently prefers the checkout's dist over
 * its own embedded copy (the build-time `import.meta.url` caveat in
 * AGENTS.md), and this is the only way to see that from outside.
 */
export function staticSource(): StaticSource {
  return chosenSource;
}

/**
 * Boot-time source selection (spec 2026-09-03 §4): a built dist dir on disk
 * wins (a dev run and a checkout-based deployment stay byte-identical), else the
 * bytes embedded in this binary, else boot fails loudly — an extended form of
 * the disk factory's own "built frontend not found" throw.
 *
 * Exported for tests; `server.ts` calls it with the real `FRONTEND_DIST` and
 * the generated `EMBEDDED` flag.
 *
 * @param distDir - absolute path to the on-disk frontend dist to prefer
 * @param embedded - whether this build carries an embedded SPA
 */
export function selectStaticPlugin(distDir: string, embedded: boolean) {
  if (existsSync(join(distDir, "index.html"))) {
    chosenSource = "disk";
    return staticPlugin(distDir);
  }
  if (embedded) {
    chosenSource = "embedded";
    return embeddedStaticPlugin();
  }
  throw new Error(
    `static plugin: built frontend not found at ${join(distDir, "index.html")}; and no embedded assets in this binary`,
    { cause: new Error(distDir) },
  );
}
