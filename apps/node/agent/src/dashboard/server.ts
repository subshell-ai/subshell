import type { NodeConfig } from "../config.js";
import { log } from "../log.js";
import { refuseRequest } from "./guards.js";
import { buildRoutes } from "./routes.js";
import { openWebStatic, type WebStatic } from "./web-static.js";

/**
 * `startNodeDashboard` — the loopback admin surface of `subshell run`
 * (spec 2026-09-19).
 *
 * The order of the three startup facts is the whole design:
 *
 * 1. **Bind `127.0.0.1`, never a wildcard.** The dashboard performs every act
 *    the local CLI performs, and it answers with no credential — so the
 *    listen address IS the access control. LAN reach would be a protocol
 *    decision (docs/security.md §12 class), not a flag.
 * 2. **Then check the request** (`guards.ts`): loopback Host (a rogue DNS
 *    record pointing at this machine's socket answers 403 before any route
 *    runs), loopback Origin when one is present, and JSON content-type on
 *    every mutation — which is what makes the Origin check load-bearing
 *    cross-origin: without a preflight-legal body a cross-origin form POST
 *    would carry no Origin at all.
 * 3. **Fail soft.** A busy port, or any listen error, costs the dashboard and
 *    never the daemon: the socket to the plane is this process's first job,
 *    and the server that cannot bind answers through the caller's catch
 *    rather than as an unhandled rejection.
 *
 * The API routes answer before the SPA fallback, and the fallback answers for
 * everything else the browser asks for (disk dist → embedded bytes → notice
 * page) — so an unknown path under /api is the SPA's shell, exactly as on the
 * plane's server, and a typo'd API path reads as a page rather than a JSON
 * 404. That is the accepted trade of one static surface, copied deliberately.
 */

export interface DashboardHandle {
  /** The port actually bound (differs from the requested one when :0 was asked). */
  port: number;
  /** What is serving the pages, for the log line and the daemon's own report. */
  webSource: WebStatic["source"];
  /** Stop listening. Idempotent: a second stop is swallowed. */
  stop(): void;
}

export interface DashboardOptions {
  /** Bind port; default 3090 (the documented floor above the server's :3080). */
  port?: number;
  /** Bind address; override exists for tests, NOT for operators (see header). */
  hostname?: string;
  /** Injected for tests; production opens the real disk→embedded→notice ladder. */
  web?: WebStatic;
}

/**
 * Bind and serve. Rejects only on a listen failure (EADDRINUSE included) —
 * `cli.ts` logs-and-continues on that, and nothing here should make that
 * swallow a worse error unknowable.
 */
export async function startNodeDashboard(cfg: NodeConfig, opts: DashboardOptions = {}): Promise<DashboardHandle> {
  const web = opts.web ?? openWebStatic();
  const app = buildRoutes(cfg)
    // The guard runs for every request including the SPA fallback: a page
    // served to a foreign Host would be a page that then fetches from it.
    .onBeforeHandle(({ request, headers }) => {
      const refusal = refuseRequest({
        method: request.method,
        hostHeader: headers.host ?? null,
        originHeader: headers.origin ?? null,
        contentType: headers["content-type"] ?? null,
      });
      return refusal ?? undefined;
    })
    .all("/*", ({ request }) => {
      const url = new URL(request.url);
      // The API had its turn inside buildRoutes; anything reaching here is a
      // page, an asset, or a miss the static ladder classifies.
      return web.serve(url.pathname, request.headers.get("accept"));
    })
    .onError(({ code, error }) => {
      // A validation failure is the caller's contract error — the plane
      // answers those with status bodies of its own; a surprise is a 500
      // whose message is not a browser's to read but whose shape always is.
      if (code === "VALIDATION") {
        return new Response(JSON.stringify({ error: "malformed request body" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        });
      }
      log(`dashboard: ${error instanceof Error ? error.message : String(error)}`);
      return new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });

  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? 3090;
  // Elysia's `listen` returns a promise at runtime (the sync handle is
  // Bun-specific sugar); awaiting it is what turns a busy port into THIS
  // rejection rather than an unhandled one — see the header.
  const server = await (
    app as unknown as {
      listen(o: { hostname: string; port: number }): PromiseLike<{ port?: number }> | { port?: number };
    }
  ).listen({ hostname, port });
  const bound = await Promise.resolve(server);
  let stopped = false;
  return {
    port: typeof bound?.port === "number" ? bound.port : port,
    webSource: web.source,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        (bound as unknown as { stop?: () => void }).stop?.();
      } catch {
        /* already gone */
      }
    },
  };
}
