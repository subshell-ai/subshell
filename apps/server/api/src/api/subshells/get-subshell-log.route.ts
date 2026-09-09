import { Elysia } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { SubshellLogTailSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `GET /api/subshells/:id/log` — tail of the subshell's pane log (owner-only). */
export const getSubshellLogRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/log",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      return await ctx.services.subshells.getSubshellLogTail(user.id, params.id, actor);
    },
    {
      response: {
        200: SubshellLogTailSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        // Spec §5.6: the row's agent node has no live connection (409
        // NODE_OFFLINE, the create/restart mapping).
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSubshellLogTail",
        tags: ["subshells"],
        description: "Tail of the subshell's pane log (ANSI-stripped): why a harness exited, if it did",
      },
    },
  );
