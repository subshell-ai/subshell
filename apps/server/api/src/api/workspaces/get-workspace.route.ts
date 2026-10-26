import { Elysia } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { WorkspaceDetailSchema } from "@/api/schemas/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";

/** `GET /api/workspaces/:id` — one workspace with its panes and each pane's subshell summary. */
export const getWorkspaceRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id",
    async ({ params, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.getWorkspace(user.id, params.id);
    },
    {
      response: {
        200: WorkspaceDetailSchema,
        401: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getWorkspace",
        tags: ["workspaces"],
        description: "Gets one workspace with its panes and each pane's subshell summary",
      },
    },
  );
