import { Elysia } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { SubshellSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `GET /api/subshells/:id` — gets a single subshell by id. */
export const getSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      return await ctx.services.subshells.getSubshell(user.id, params.id, actor);
    },
    {
      response: {
        200: SubshellSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSubshell",
        tags: ["subshells"],
        description: "Gets a single subshell by id",
      },
    },
  );
