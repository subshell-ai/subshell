import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { WorkspaceSchema } from "@/api/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `GET /api/workspaces` — lists the authenticated user's workspaces. */
export const listWorkspacesRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.listWorkspaces(user.id);
    },
    {
      response: {
        200: t.Array(WorkspaceSchema, { description: "The caller's workspaces" }),
        401: "ApiErrorResponse",
      },
      detail: {
        operationId: "listWorkspaces",
        tags: ["workspaces"],
        description: "Lists the authenticated user's workspaces",
      },
    },
  );
