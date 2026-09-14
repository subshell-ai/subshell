import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { WorkspaceSchema } from "@/api/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const CreateWorkspaceBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 120, description: "Workspace name (unique per user, unless draft)" }),
  draft: t.Optional(
    t.Boolean({
      description:
        "True creates it as an unsaved draft: hidden from the workspace list, and free to share a name with the caller's other drafts",
    }),
  ),
  subshellId: t.Optional(
    t.String({
      minLength: 1,
      description:
        "Subshell to put in the workspace's first pane, created in this same call; 404 when the caller cannot see it",
    }),
  ),
});

/** `POST /api/workspaces` — creates a workspace for the authenticated user. */
export const createWorkspaceRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.createWorkspace({
        userId: user.id,
        name: body.name,
        draft: body.draft,
        subshellId: body.subshellId,
      });
    },
    {
      body: CreateWorkspaceBodySchema,
      response: {
        200: WorkspaceSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "createWorkspace",
        tags: ["workspaces"],
        description: "Creates a workspace for the authenticated user, optionally holding one subshell already",
      },
    },
  );
