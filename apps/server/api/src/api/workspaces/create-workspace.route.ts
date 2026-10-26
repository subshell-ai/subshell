import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { WorkspaceSchema } from "@/api/schemas/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { HttpError } from "@/shared/errors.js";

const CreateWorkspaceBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 120, description: "Workspace name" }),
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
      // The shared label rule (control bytes, format characters, collapse,
      // code-point cap) — the name renders in every pane header a workspace
      // is shared into. An empty result means nothing printable was entered;
      // a workspace always has one, so that is a 400. Names are not unique
      // (0058): a collision with an existing workspace is fine.
      const name = normalizeLabel(body.name, 120);
      if (!name) throw new HttpError(400, "Workspace name cannot be blank");
      return await ctx.services.workspaces.createWorkspace({
        userId: user.id,
        name,
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
      },
      detail: {
        operationId: "createWorkspace",
        tags: ["workspaces"],
        description: "Creates a workspace for the authenticated user, optionally holding one subshell already",
      },
    },
  );
