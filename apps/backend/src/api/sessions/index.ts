import { Elysia } from "elysia";
import { createSessionRoute } from "@/api/sessions/create-session.route.js";
import { deleteSessionRoute } from "@/api/sessions/delete-session.route.js";
import { extendSessionTokenRoute } from "@/api/sessions/extend-session-token.route.js";
import { getSessionRoute } from "@/api/sessions/get-session.route.js";
import { getSessionLogRoute } from "@/api/sessions/get-session-log.route.js";
import { listSessionsRoute } from "@/api/sessions/list-sessions.route.js";
import { restartSessionRoute } from "@/api/sessions/restart-session.route.js";
import { sessionAttentionRoute } from "@/api/sessions/session-attention.route.js";
import { sessionSharesRoutes } from "@/api/sessions/session-shares.route.js";
import { summarySessionRoute } from "@/api/sessions/summary-session.route.js";
import { terminateSessionRoute } from "@/api/sessions/terminate-session.route.js";
import { updateSessionNameRoute } from "@/api/sessions/update-session-name.route.js";
import { updateSessionNotesRoute } from "@/api/sessions/update-session-notes.route.js";
import { updateSessionNotifyRoute } from "@/api/sessions/update-session-notify.route.js";

/**
 * `/api/sessions` — one Elysia instance per endpoint, mounted in the original
 * monolithic route's order (convention, not a router constraint: Elysia ranks
 * static segments above `/:id` regardless of order). Business logic lives in
 * `SessionsService` (`src/services/sessions.service.ts`), reached by handlers
 * via `ctx`.
 */
export const sessionRoutes = new Elysia({ prefix: "/api/sessions" })
  .use(createSessionRoute)
  .use(listSessionsRoute)
  .use(summarySessionRoute)
  .use(getSessionRoute)
  .use(getSessionLogRoute)
  .use(sessionSharesRoutes)
  .use(updateSessionNotesRoute)
  .use(updateSessionNotifyRoute)
  .use(sessionAttentionRoute)
  .use(updateSessionNameRoute)
  .use(restartSessionRoute)
  .use(terminateSessionRoute)
  .use(extendSessionTokenRoute)
  .use(deleteSessionRoute);
