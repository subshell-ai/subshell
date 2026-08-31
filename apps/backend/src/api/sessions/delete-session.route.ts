import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `DELETE /api/sessions/:id` — deletes a session (terminates first if running). */
export const deleteSessionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/:id",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "write");
      return await ctx.services.sessions.deleteSession(user.id, params.id);
    },
    {
      response: {
        200: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "deleteSession",
        tags: ["sessions"],
        description: "Deletes a session (terminates first if running)",
      },
    },
  );
