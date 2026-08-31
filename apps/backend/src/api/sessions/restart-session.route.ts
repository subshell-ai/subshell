import { Elysia } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { CreateSessionResponseSchema } from "@/api/sessions/create-session.route.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `POST /api/sessions/:id/restart` — revives this session in place (same id): new process, same row, conversation resumed when its transcript survived. */
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
        description:
          "Revive this session in place: same id and name, new process, conversation resumed when its transcript survived",
      },
    },
  );
