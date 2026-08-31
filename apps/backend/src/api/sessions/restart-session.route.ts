import { Elysia } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { CreateSessionResponseSchema } from "@/api/sessions/create-session.route.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `POST /api/sessions/:id/restart` — starts a new session with the same profile + working directory. */
export const restartSessionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/restart",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "write");
      return await ctx.services.sessions.restartSession(user.id, params.id);
    },
    {
      response: {
        200: CreateSessionResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "restartSession",
        tags: ["sessions"],
        description: "Start a new session with the same profile + working directory",
      },
    },
  );
