import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `POST /api/subshells/:id/terminate` — terminates a subshell (kills the harness process tree). */
export const terminateSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/terminate",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.terminateSubshell(user.id, params.id, actor);
    },
    {
      response: {
        200: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "terminateSubshell",
        tags: ["subshells"],
        description: "Terminates a subshell (kills the harness process tree)",
      },
    },
  );
