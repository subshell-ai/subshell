import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const AddPaneBodySchema = t.Object({
  sessionId: t.String({ minLength: 1, description: "Session to render in the new pane" }),
});

/** `POST /api/workspaces/:id/panes` — adds a pane holding one of the caller's sessions. */
export const addWorkspacePaneRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/panes",
    async ({ params, body, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.addWorkspacePane(user.id, params.id, body.sessionId);
    },
    {
      body: AddPaneBodySchema,
      response: {
        200: t.Object({ id: t.String({ description: "Id of the new pane" }) }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "addWorkspacePane",
        tags: ["workspaces"],
        description: "Adds a pane holding one of the caller's sessions",
      },
    },
  );
