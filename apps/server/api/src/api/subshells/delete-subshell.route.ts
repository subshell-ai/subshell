import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `DELETE /api/subshells/:id` — deletes a subshell (terminates first if running). */
export const deleteSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/:id",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.deleteSubshell(user.id, params.id, actor);
    },
    {
      response: {
        200: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "deleteSubshell",
        tags: ["subshells"],
        description: "Deletes a subshell (terminates first if running)",
      },
    },
  );
