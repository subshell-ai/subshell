import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { SubshellSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `GET /api/subshells` — lists the authenticated user's subshells. */
export const listSubshellsRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      return await ctx.services.subshells.listSubshells(user.id);
    },
    {
      response: {
        200: t.Array(SubshellSchema, { description: "User's subshells" }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSubshells",
        tags: ["subshells"],
        description: "Lists the authenticated user's subshells",
      },
    },
  );
