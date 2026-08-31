import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const SaveLayoutBodySchema = t.Object({
  layout: t.Any({ description: "Serialized dockview layout tree, as produced by its toJSON()" }),
});

/** `PUT /api/workspaces/:id/layout` — saves the workspace's tiling layout. */
export const saveWorkspaceLayoutRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id/layout",
    async ({ params, body, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.saveWorkspaceLayout(user.id, params.id, body.layout);
    },
    {
      body: SaveLayoutBodySchema,
      response: {
        200: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "saveWorkspaceLayout",
        tags: ["workspaces"],
        description: "Saves the workspace's tiling layout",
      },
    },
  );
