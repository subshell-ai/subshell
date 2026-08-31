import { Elysia } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { SessionSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `GET /api/sessions/:id` — gets a single session by id. */
export const getSessionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "read");
      return await ctx.services.sessions.getSession(user.id, params.id);
    },
    {
      response: {
        200: SessionSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSession",
        tags: ["sessions"],
        description: "Gets a single session by id",
      },
    },
  );
