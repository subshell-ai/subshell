import { Elysia } from "elysia";
import { autostartRoute } from "@/api/admin-server/autostart.route.js";
import { getServerRoute } from "@/api/admin-server/get-server.route.js";
import { loggingRoute } from "@/api/admin-server/logging.route.js";
import { logsRoute } from "@/api/admin-server/logs.route.js";
import { patchConfigRoute } from "@/api/admin-server/patch-config.route.js";
import { restartRoute } from "@/api/admin-server/restart.route.js";

/**
 * `/api/admin/server` — the server's view of, and levers on, its own
 * deployment. One Elysia instance per endpoint, composed here (the
 * `api/channels/` convention); this file is wiring only, never a second place
 * a route's shape is stated.
 */
export const adminServerRoutes = new Elysia({ prefix: "/api/admin/server" })
  .use(getServerRoute)
  .use(patchConfigRoute)
  .use(restartRoute)
  .use(autostartRoute)
  .use(logsRoute)
  .use(loggingRoute);
