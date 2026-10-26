import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { installScriptRoute } from "@/api/install-script.js";
import { accessGuardPlugin } from "@/api/middleware/access-guard.plugin.js";
import { authPlugin } from "@/api/middleware/auth.plugin.js";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { openApiPlugin } from "@/api/middleware/openapi.plugin.js";
import { selectStaticPlugin } from "@/api/middleware/static.plugin.js";
import { pvHttpRoute } from "@/api/previews/http.js";
import { previewWsRoute } from "@/api/previews/ws.js";
import { routes } from "@/api/routes.js";
import { apiModels } from "@/api/schemas/index.js";
import { startLivePublisher } from "@/api/ws/live-publisher.js";
import { closeAllViewers } from "@/api/ws/viewers.js";
import { wsPlugin } from "@/api/ws/ws.plugin.js";
import { EMBEDDED } from "@/generated/embedded-web.js";
import { originRegistry } from "@/modules/network/trusted-origins.js";
import { configureRestartViewers } from "@/modules/server/server-restart.js";
import { logger } from "@/shared/logger.js";

/** Built SPA served by Elysia (prod single-port model). Relative to dist/ */
const FRONTEND_DIST = new URL("../../web/dist", import.meta.url).pathname;

/**
 * The CORS predicate: exact membership of the request's `Origin` in the live
 * registry. `@elysiajs/cors` 1.4.2 calls a function `origin` with the raw
 * `Request` (`dist/index.mjs`, `origin2(request) === true`) and on `true`
 * echoes that header back with `vary: Origin`. Exported so the integration
 * test mounts the very predicate the app runs, not a copy.
 *
 * Opaque-origin preview resources have a capability-path exception below;
 * dashboard APIs never inherit it. Exact match otherwise. The plugin's own string branch also accepted a
 * SCHEMELESS entry by stripping the scheme off the incoming header — which
 * made `box.local:3080` a scheme wildcard there (security-context.md). The
 * operator writer already refuses schemeless entries; this closes the branch
 * for anything an env var or hand-edit still carries.
 */
export function corsOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Opaque preview documents may load their capability-bound resources.
  // Never extend this exception to API routes or the dashboard sockets.
  if (origin === "null" && /^\/pv\/[0-9a-f]{32}\//.test(new URL(request.url).pathname)) return true;
  return origin !== null && originRegistry().has(origin);
}

export function createApp() {
  configureRestartViewers(closeAllViewers);
  const app = new Elysia()
    // Mounted first so the global onError owns every failure thrown anywhere
    // in the app (its hooks are registered before any route exists).
    .use(errorHandlerPlugin)
    // The Cloudflare Access front door, BEFORE everything else: a hostname a
    // network plugin published on the open internet must be checked before
    // cors, the rate limiter, `/install.sh`, auth, the static SPA or a
    // WebSocket upgrade can answer for it. A hostname no active guard names
    // is not touched at all, so loopback and the LAN are unchanged.
    .use(accessGuardPlugin)
    // Shared response models (ApiErrorResponse) registered app-wide so route
    // `response` maps can reference them by name; named plugin, so per-route
    // `.use(apiModels)` calls (test-isolated instances) dedupe to this one.
    .use(apiModels)
    .use(cors({ origin: corsOriginAllowed }))
    .use(openApiPlugin)
    // Rate limiter must mount BEFORE the auth passthrough so its explicit
    // POST /api/auth/sign-in/email route wins over the .all("/api/auth/*").
    .use(authRateLimitRoutes)
    // Root-level (not under /api) and BEFORE the static SPA plugin, same
    // off-the-tree precedent as the rate limiter: `/install.sh` is a dotted
    // top-level path the static plugin's file branch would otherwise 404
    // (it is not a dist file). spec 2026-08-31 §8.
    .use(installScriptRoute)
    // Root-level `/pv/<ref>/...` like install.sh above, and for the same
    // reason: mounted AFTER the static plugin, every proxy path the pane
    // browser loads would hit the file branch and 404. The session ref in
    // the path is the credential (spec 2026-10-21 §6/§10); no cookie or
    // bearer gate stands in front of it, and REQUEST_LOG_IGNORE keeps the
    // secret out of request lines.
    .use(pvHttpRoute)
    .use(authPlugin)
    // Disk dist wins when present (dev and checkout deployments behave alike);
    // else the SPA embedded by scripts/embed-web.ts; else boot fails loudly.
    .use(selectStaticPlugin(FRONTEND_DIST, EMBEDDED))
    .use(wsPlugin)
    // The proxy's WS half rides the same wildcard as pvHttpRoute; Elysia
    // dispatches upgrade GETs here and plain GETs to the HTTP routes
    // (spike-verified for one dynamic pattern across two modules).
    .use(previewWsRoute())
    .use(routes);

  return app;
}

export type App = ReturnType<typeof createApp>;

export async function startServer({ port, host }: { port: number; host: string }) {
  const app = createApp();

  app.listen({ port, hostname: host }, () => {
    logger.info(`Server: http://${host}:${port}`);
    logger.info(`Server docs: http://${host}:${port}/docs`);
    // Armed here because the SERVER HANDLE is what broadcasts, and it does not
    // exist until the listener does. Held for the life of the process: there
    // is no unsubscribe path because there is no point in the process's life
    // where the dashboard should stop being told about changes.
    const server = app.server;
    if (server) startLivePublisher({ target: server });
  });
  return app;
}
