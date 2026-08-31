import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { WorkspaceSchema } from "@/api/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const UpdateWorkspaceBodySchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120, description: "Workspace name" })),
});

/** `PUT /api/workspaces/:id` — renames or updates a workspace. */
export const updateWorkspaceRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id",
    async ({ params, body, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.updateWorkspace(user.id, params.id, body);
    },
    {
      body: UpdateWorkspaceBodySchema,
      response: {
        200: WorkspaceSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateWorkspace",
        tags: ["workspaces"],
        description: "Renames or updates a workspace",
      },
    },
  );
