import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED, EMBEDDED_WEB } from "../generated/embedded-web.js";

/**
 * The dashboard SPA's serving contract: disk dist first, embedded bytes next,
 * a one-line notice last.
 *
 * A deliberate COMPACT port of the server's `plugins/static.plugin.ts` +
 * `static-shared.ts` (AGPL; this app is Apache — the `log-file.ts` copy rule,
 * stated rather than discovered). Compact, because the node surface needs one
 * caller (this server) rather than the server's two plugin factories, but the
 * CONTRACT is kept whole: content-hashed assets cache forever, the shell
 * revalidates always, dotted paths are files, everything else is an SPA
 * route falling back to the shell, traversal never reaches disk or map, and
 * embedded entries carry a strong ETag.
 *
 * The LAST rung is the honest difference from the server: a dev-compiled
 * `subshell` embeds nothing and may sit beside no checkout, and here booting
 * LOUDLY would be wrong — the dashboard is a side surface of a daemon whose
 * first job is holding the plane socket. So the absence answers with a page,
 * not a crash.
 */

/** The content types that occur in a Vite build (the server map, minus what the dashboard never emits). */
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
  ".map": "application/json",
};

const extOf = (path: string): string => path.match(/\.[a-z0-9]+$/i)?.[0] ?? "";
const contentTypeFor = (ext: string): string => CONTENT_TYPES[ext] ?? "application/octet-stream";

/**
 * The response-body view of a file buffer. The bytes never move; this only
 * restates the `Uint8Array` as the `ArrayBuffer` shape this app's DOM lib
 * typing accepts for a `Response` body (`Uint8Array<ArrayBufferLike>` is
 * structurally excluded by `BodyInit` under the TS 5.7+ typed-array generics).
 */
const responseBody = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The shell revalidates always; hashed assets never need to come back. */
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" };
const assetCacheControl = (ext: string): string =>
  /\.(js|mjs|css)$/.test(ext) ? "public, max-age=604800, immutable" : "public, max-age=3600";

/** A decoded, traversal-free dist-relative POSIX path, or null when untrustworthy. */
function safeKey(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const rel = normalize(decoded.replace(/^\/+/, ""));
  const segments = rel.split(/[/\\]/).filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null;
  return segments.length === 0 ? null : segments.join("/");
}

/** Dev-run dist location: `apps/node/web/dist`, a sibling of this app. */
export function dashboardDistDir(): string {
  return fileURLToPath(new URL("../../../web/dist", import.meta.url));
}

const NOTICE = `<!doctype html><html><head><meta charset="utf-8"><title>Subshell node: no dashboard bundled</title>
<style>body{font:15px/1.6 system-ui;margin:12vh auto;max-width:38rem;padding:0 1.5rem;color:#1a1a1a;background:#fff}
code{background:#f2f2f2;padding:.1em .35em;border-radius:.3em}</style></head>
<body><h1>This binary embeds no dashboard.</h1>
<p>The API is live at <code>/api/…</code>. To get the pages: build <code>apps/node/web</code>
(<code>bun run build</code>) and restart, or install a <code>cli-node-v*</code> release binary,
which carries the dashboard embedded.</p></body></html>`;

/** What the SPA shell is served from, for the log line and `/api/self` — disk beats embedded. */
export type WebSource = "disk" | "embedded" | "absent";

export interface WebStatic {
  source: WebSource;
  /** null = not ours to answer (the caller's /api routes already had their turn). */
  serve(pathname: string, accept: string | null): Response;
}

/**
 * Choose the source ONCE at boot and freeze it (the server's `selectStaticPlugin`
 * rule: re-deriving later would report a source the process is not serving).
 */
export function openWebStatic(distDir = dashboardDistDir()): WebStatic {
  const indexPath = join(distDir, "index.html");
  if (existsSync(indexPath)) {
    // Re-read the shell on change so a `vite build --watch` refreshes an open
    // tab's next navigation (the disk plugin's mtime dance, kept).
    let shell: { body: Uint8Array; mtimeMs: number; size: number } | null = null;
    const currentIndex = (): Uint8Array => {
      const stat = statSync(indexPath);
      if (!shell || shell.mtimeMs !== stat.mtimeMs || shell.size !== stat.size) {
        shell = { body: new Uint8Array(readFileSync(indexPath)), mtimeMs: stat.mtimeMs, size: stat.size };
      }
      return shell.body;
    };
    return {
      source: "disk",
      serve: (pathname) => diskResponse(distDir, pathname, currentIndex),
    };
  }
  if (EMBEDDED && EMBEDDED_WEB["index.html"] !== undefined) {
    const entries = new Map<string, { body: Uint8Array; etag: string }>();
    const entryFor = (key: string) => {
      let e = entries.get(key);
      if (!e) {
        const body = Buffer.from(EMBEDDED_WEB[key], "base64");
        e = { body: new Uint8Array(body), etag: `"${createHash("sha256").update(body).digest("hex")}"` };
        entries.set(key, e);
      }
      return e;
    };
    return {
      source: "embedded",
      serve: (pathname) => {
        const key = safeKey(pathname);
        if (key !== null && EMBEDDED_WEB[key] !== undefined) {
          const e = entryFor(key);
          const ext = extOf(key);
          const cc = ext === ".html" ? HTML_HEADERS["Cache-Control"] : assetCacheControl(ext);
          return new Response(responseBody(e.body), {
            headers: { "Content-Type": contentTypeFor(ext), "Cache-Control": cc, ETag: e.etag },
          });
        }
        // SPA fallback for path-without-dot routes; dotted misses are 404s.
        if (pathname.includes(".")) return new Response("not found", { status: 404 });
        const shell = entryFor("index.html");
        return new Response(responseBody(shell.body), { headers: { ...HTML_HEADERS, ETag: shell.etag } });
      },
    };
  }
  return {
    source: "absent",
    serve: (pathname, accept) =>
      pathname === "/" || (accept ?? "").includes("text/html")
        ? new Response(NOTICE, { headers: HTML_HEADERS })
        : new Response("not found", { status: 404 }),
  };
}

function diskResponse(distDir: string, pathname: string, currentIndex: () => Uint8Array): Response {
  const key = safeKey(pathname);
  if (key !== null) {
    const file = join(distDir, key);
    if (existsSync(file) && statSync(file).isFile()) {
      const ext = extOf(key);
      const body = readFileSync(file);
      const cc = ext === ".html" ? HTML_HEADERS["Cache-Control"] : assetCacheControl(ext);
      return new Response(responseBody(body), {
        headers: { "Content-Type": contentTypeFor(ext), "Cache-Control": cc },
      });
    }
    if (pathname.includes(".")) return new Response("not found", { status: 404 });
  }
  return new Response(responseBody(currentIndex()), { headers: HTML_HEADERS });
}
