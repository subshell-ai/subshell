import { Elysia } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { SessionLogTailSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `GET /api/sessions/:id/log` — tail of the session's pane log (owner-only). */
export const getSessionLogRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/log",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "read");
      return await ctx.services.sessions.getSessionLogTail(user.id, params.id);
    },
    {
      response: {
        200: SessionLogTailSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSessionLogTail",
        tags: ["sessions"],
        description: "Tail of the session's pane log (ANSI-stripped) — why a harness exited, if it did",
      },
    },
  );
