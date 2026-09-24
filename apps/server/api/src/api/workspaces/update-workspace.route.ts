import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, HttpError } from "@/api/auth-guard.js";
import { WorkspaceSchema } from "@/api/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const UpdateWorkspaceBodySchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120, description: "Workspace name" })),
  draft: t.Optional(
    t.Literal(false, {
      description: "false promotes a draft to a saved workspace; the only transition allowed",
    }),
  ),
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
      // The label rule create gained on 2026-09-23 applies HERE too, or a
      // workspace could be created clean and renamed dirty — same name, same
      // unique index, same renders. `updateWorkspace` treats an absent name
      // as "leave it", so only a PRESENT name is normalized, and one that
      // empties out answers the same 400 create gives.
      let name = body.name;
      if (name !== undefined) {
        name = normalizeLabel(name, 120);
        if (!name) throw new HttpError(400, "Workspace name cannot be blank");
      }
      return await ctx.services.workspaces.updateWorkspace(user.id, params.id, { ...body, name });
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
        description: "Renames a workspace, and/or promotes an unsaved draft to a saved one",
      },
    },
  );
