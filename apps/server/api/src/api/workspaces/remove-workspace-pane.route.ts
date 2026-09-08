import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `DELETE /api/workspaces/:id/panes/:paneId` — removes a pane (the subshell is untouched). */
export const removeWorkspacePaneRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/:id/panes/:paneId",
    async ({ params, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.removeWorkspacePane(user.id, params.id, params.paneId);
    },
    {
      response: {
        200: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
        401: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "removeWorkspacePane",
        tags: ["workspaces"],
        description: "Removes a pane from a workspace (the subshell is untouched)",
      },
    },
  );
