import { LIST_SEARCH_MAX } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { matchesListQuery } from "@/api/list-filter.js";
import { WorkspaceListItemSchema } from "@/api/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const ListWorkspacesQuerySchema = t.Object({
  q: t.Optional(t.String({ maxLength: LIST_SEARCH_MAX.workspaces })),
  subshellId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 128,
      description: "Restrict to the caller's workspaces holding a pane for this subshell, most recently updated first",
    }),
  ),
});

/**
 * `GET /api/workspaces` — lists the authenticated user's workspaces, each
 * with its panes so the rail tree needs exactly one request.
 *
 * The draft machinery (and with it the `?drafts=only` read and the
 * locale/time-zone label search that only ever served draft titles) left with
 * spec 2026-10-17: a workspace now exists exactly as long as it holds a tab,
 * so there is no unsaved half-state to hide or sweep.
 */
export const listWorkspacesRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ query, actor, user, ctx }) => {
      requireCookieActor(actor);
      const rows = await ctx.services.workspaces.listWorkspaces(user.id, { subshellId: query.subshellId });
      return rows.filter((w) => matchesListQuery(query.q, w.name));
    },
    {
      query: ListWorkspacesQuerySchema,
      response: {
        200: t.Array(WorkspaceListItemSchema, { description: "The caller's workspaces, each with its panes" }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
      },
      detail: {
        operationId: "listWorkspaces",
        tags: ["workspaces"],
        description: "Lists the authenticated user's workspaces with their panes",
      },
    },
  );
