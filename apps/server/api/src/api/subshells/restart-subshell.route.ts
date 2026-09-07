import { Elysia } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { CreateSubshellResponseSchema } from "@/api/subshells/create-subshell.route.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `POST /api/subshells/:id/restart` — revives this subshell in place (same id): new process, same row, conversation resumed when its transcript survived. */
export const restartSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/restart",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.restartSubshell(user.id, params.id, actor);
    },
    {
      response: {
        200: CreateSubshellResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        // Spec §5.6: the row's agent node has no live connection (409
        // NODE_OFFLINE); the parked row is rolled back before the 409.
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "restartSubshell",
        tags: ["subshells"],
        description:
          "Revive this subshell in place: same id and name, new process, conversation resumed when its transcript survived",
      },
    },
  );
