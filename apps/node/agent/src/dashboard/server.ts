import type { NodeConfig } from "../config.js";
import { log } from "../log.js";
import { buildRoutes, guardResponse } from "./routes.js";
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
    // The API routes carry the guard on their own instance (`routes.ts`
    // registers `onBeforeHandle` first); a `.use()`d instance's lifecycle
    // NEVER reaches a later wildcard on the outer one — three live smokes
    // proved every outer-lifecycle variant passes exactly one of the two
    // surfaces. So the fallback calls `guardResponse` explicitly, and the
    // wire test in `__tests__/dashboard.test.ts` refuses a foreign Host on
    // BOTH kinds of path.
    .all("/*", ({ request }) => {
      const refusal = guardResponse(request);
      if (refusal !== null) return refusal;
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
  const port = opts.port ?? 3090; // `??`, not `||`: :0 is the ask-the-OS port, not "no port"
  // Elysia's `listen` is a promise at runtime (verified against 1.4.29:
  // awaiting is how a busy port becomes THIS rejection rather than an
  // unhandled one — see the header). :0 asks the OS, and `app.server.port`
  // then names the real one — what `run`'s log line prints and the tests
  // call on.
  const server = await (
    app as unknown as {
      listen(o: { hostname: string; port: number }): PromiseLike<unknown>;
    }
  ).listen({ hostname, port });
  await Promise.resolve(server); // settle the bind; the handle lives on `app`
  // The resolved object is Elysia's own instance (probed on 1.4.29: it
  // carries `server`, not a plain `{port}`), and `app.server` is Bun's serve
  // handle — whose `port` is the OS-assigned one when :0 was asked.
  const realPort = (app as unknown as { server?: { port?: number } }).server?.port ?? port;
  let stopped = false;
  return {
    port: realPort,
    webSource: web.source,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        (app as unknown as { stop?: () => void }).stop?.();
      } catch {
        /* already gone */
      }
    },
  };
}
