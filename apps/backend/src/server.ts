import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { routes } from "@/api/routes.js";
import { TRUSTED_ORIGINS } from "@/constants.js";
import { authPlugin } from "@/plugins/auth.plugin.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { staticPlugin } from "@/plugins/static.plugin.js";
import { apiModels } from "@/schema/index.js";
import { logger } from "@/utils/logger.js";
import { wsPlugin } from "@/ws/ws.plugin.js";

/** Built SPA served by Elysia (prod single-port model). Relative to dist/ */
const FRONTEND_DIST = new URL("../../frontend/dist", import.meta.url).pathname;

export function createApp() {
  const app = new Elysia()
    // Mounted first so the global onError owns every failure thrown anywhere
    // in the app (its hooks are registered before any route exists).
    .use(errorHandlerPlugin)
    // Shared response models (ApiErrorResponse) registered app-wide so route
    // `response` maps can reference them by name; named plugin, so per-route
    // `.use(apiModels)` calls (test-isolated instances) dedupe to this one.
    .use(apiModels)
    .use(cors({ origin: TRUSTED_ORIGINS }))
    .use(openapi({ path: "/docs" }))
    // Rate limiter must mount BEFORE the auth passthrough so its explicit
    // POST /api/auth/sign-in/email route wins over the .all("/api/auth/*").
    .use(authRateLimitRoutes)
    .use(authPlugin)
    .use(staticPlugin(FRONTEND_DIST))
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
