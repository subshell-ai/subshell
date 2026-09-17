import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { installScriptRoute } from "@/api/install-script.js";
import { routes } from "@/api/routes.js";
import { EMBEDDED } from "@/generated/embedded-web.js";
import { accessGuardPlugin } from "@/plugins/access-guard.plugin.js";
import { authPlugin } from "@/plugins/auth.plugin.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { selectStaticPlugin } from "@/plugins/static.plugin.js";
import { apiModels } from "@/schema/index.js";
import { originRegistry } from "@/services/trusted-origins.js";
import { logger } from "@/utils/logger.js";
import { wsPlugin } from "@/ws/ws.plugin.js";

/** Built SPA served by Elysia (prod single-port model). Relative to dist/ */
const FRONTEND_DIST = new URL("../../web/dist", import.meta.url).pathname;

/**
 * The CORS predicate: exact membership of the request's `Origin` in the live
 * registry. `@elysiajs/cors` 1.4.2 calls a function `origin` with the raw
 * `Request` (`dist/index.mjs`, `origin2(request) === true`) and on `true`
 * echoes that header back with `vary: Origin`. Exported so the integration
 * test mounts the very predicate the app runs, not a copy.
 *
 * Exact match on purpose. The plugin's own string branch also accepted a
 * SCHEMELESS entry by stripping the scheme off the incoming header — which
 * made `box.local:3080` a scheme wildcard there (security-context.md). The
 * operator writer already refuses schemeless entries; this closes the branch
 * for anything an env var or hand-edit still carries.
 */
export function corsOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && originRegistry().has(origin);
}

export function createApp() {
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
    .use(openapi({ path: "/docs" }))
    // Rate limiter must mount BEFORE the auth passthrough so its explicit
    // POST /api/auth/sign-in/email route wins over the .all("/api/auth/*").
    .use(authRateLimitRoutes)
    // Root-level (not under /api) and BEFORE the static SPA plugin, same
    // off-the-tree precedent as the rate limiter: `/install.sh` is a dotted
    // top-level path the static plugin's file branch would otherwise 404
    // (it is not a dist file). spec 2026-08-31 §8.
    .use(installScriptRoute)
    .use(authPlugin)
    // Disk dist wins when present (dev and checkout deployments behave alike);
    // else the SPA embedded by scripts/embed-web.ts; else boot fails loudly.
    .use(selectStaticPlugin(FRONTEND_DIST, EMBEDDED))
    .use(wsPlugin)
    .use(routes);

  return app;
}

export type App = ReturnType<typeof createApp>;

export async function startServer({ port, host }: { port: number; host: string }) {
  const app = createApp();

  app.listen({ port, hostname: host }, () => {
    logger.info(`Server: http://${host}:${port}`);
    logger.info(`Server docs: http://${host}:${port}/docs`);
  });
}
