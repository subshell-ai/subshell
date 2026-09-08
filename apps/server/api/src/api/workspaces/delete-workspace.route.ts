import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `DELETE /api/workspaces/:id` — deletes a workspace; its panes cascade away. */
export const deleteWorkspaceRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/:id",
    async ({ params, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.deleteWorkspace(user.id, params.id);
    },
    {
      response: {
        200: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
        401: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "deleteWorkspace",
        tags: ["workspaces"],
        description: "Deletes a workspace; its panes cascade away",
      },
    },
  );
