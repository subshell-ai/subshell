import { Elysia } from "elysia";
import { autostartRoute } from "@/api/admin-server/autostart.route.js";
import { getServerRoute } from "@/api/admin-server/get-server.route.js";
import { getUpdateRoute } from "@/api/admin-server/get-update.route.js";
import { loggingRoute } from "@/api/admin-server/logging.route.js";
import { logsRoute } from "@/api/admin-server/logs.route.js";
import { patchConfigRoute } from "@/api/admin-server/patch-config.route.js";
import { restartRoute } from "@/api/admin-server/restart.route.js";
import { supervisionAuditRoute } from "@/api/admin-server/supervision-audit.route.js";
import { updateRoute } from "@/api/admin-server/update.route.js";
import { updateCheckRoute } from "@/api/admin-server/update-check.route.js";

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
  .use(loggingRoute)
  .use(supervisionAuditRoute)
  // `/update/check` is registered before `/update`'s POST only for reading
  // order; Elysia matches by path RANK (static segments beat `/:id`), never by
  // registration order, so the two cannot shadow each other.
  .use(getUpdateRoute)
  .use(updateCheckRoute)
  .use(updateRoute);
