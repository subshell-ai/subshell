import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { WorkspaceSchema } from "@/api/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const ListWorkspacesQuerySchema = t.Object({
  subshellId: t.Optional(
    t.String({
      minLength: 1,
      description:
        "Restrict to the caller's workspaces holding a pane for this subshell, most recently updated first, unsaved drafts INCLUDED (the unfiltered list excludes them)",
    }),
  ),
});

/** `GET /api/workspaces` — lists the authenticated user's workspaces. */
export const listWorkspacesRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ query, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.listWorkspaces(user.id, { subshellId: query.subshellId });
    },
    {
      query: ListWorkspacesQuerySchema,
      response: {
        200: t.Array(WorkspaceSchema, { description: "The caller's workspaces" }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
      },
      detail: {
        operationId: "listWorkspaces",
        tags: ["workspaces"],
        description: "Lists the authenticated user's workspaces (unsaved drafts excluded unless filtered by subshell)",
      },
    },
  );
