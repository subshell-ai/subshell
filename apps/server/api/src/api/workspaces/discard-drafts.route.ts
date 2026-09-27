import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const DiscardDraftsQuerySchema = t.Object({
  except: t.Optional(
    t.String({
      minLength: 1,
      description: "Workspace id to spare — the draft being viewed. Others are discarded.",
    }),
  ),
});

/**
 * `DELETE /api/workspaces/drafts` — discards the caller's unsaved DRAFT
 * workspaces in one sweep, except the one named by `?except=` (the draft being
 * viewed). This is the sidebar Drafts section's trashcan: the sweep is ONE
 * request rather than a DELETE per row, so a half-failed cleanup cannot leave
 * some drafts gone and others standing behind a stale optimistic list.
 *
 * Registered BEFORE the `/:id` delete route so the static `drafts` segment is
 * never shadowed by the param.
 */
export const discardDraftsRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/drafts",
    async ({ query, actor, user, ctx }) => {
      requireCookieActor(actor);
      return await ctx.services.workspaces.discardDrafts(user.id, query.except);
    },
    {
      query: DiscardDraftsQuerySchema,
      response: {
        200: t.Object({
          discarded: t.Number({ description: "How many draft workspaces were discarded" }),
        }),
        401: "ApiErrorResponse",
      },
      detail: {
        operationId: "discardWorkspaceDrafts",
        tags: ["workspaces"],
        description: "Discards the caller's unsaved draft workspaces, except an optional id to spare",
      },
    },
  );
