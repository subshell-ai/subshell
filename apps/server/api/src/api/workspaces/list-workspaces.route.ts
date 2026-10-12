import { Elysia, t } from "elysia";
import { authGuard, HttpError } from "@/api/auth-guard.js";
import { matchesListQuery } from "@/api/list-filter.js";
import { WorkspaceSchema } from "@/api/models.js";
import { requireCookieActor } from "@/api/workspaces/require-cookie-actor.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const ListWorkspacesQuerySchema = t.Object({
  q: t.Optional(t.String()),
  locale: t.Optional(t.String()),
  timeZone: t.Optional(t.String()),
  subshellId: t.Optional(
    t.String({
      minLength: 1,
      description:
        "Restrict to the caller's workspaces holding a pane for this subshell, most recently updated first, unsaved drafts INCLUDED (the unfiltered list excludes them)",
    }),
  ),
  drafts: t.Optional(
    t.Literal("only", {
      description: "Return only the caller's UNSAVED draft workspaces (the Workspaces rail's Drafts section)",
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
      const rows = await ctx.services.workspaces.listWorkspaces(user.id, {
        subshellId: query.subshellId,
        draftsOnly: query.drafts === "only",
      });
      if (query.drafts !== "only" || !query.q?.trim()) return rows.filter((w) => matchesListQuery(query.q, w.name));
      let formatter: Intl.DateTimeFormat;
      try {
        formatter = new Intl.DateTimeFormat(query.locale, {
          timeZone: query.timeZone,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      } catch {
        throw new HttpError(400, "Choose a valid locale and time zone.");
      }
      const labels = new Map<string, number>();
      return rows
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .filter((w) => {
          const date = new Date(w.createdAt);
          const base = Number.isNaN(date.getTime()) ? w.createdAt : formatter.format(date);
          const count = (labels.get(base) ?? 0) + 1;
          labels.set(base, count);
          return matchesListQuery(query.q, count === 1 ? base : `${base} · ${w.name}`);
        });
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
        description:
          "Lists the authenticated user's workspaces (unsaved drafts excluded unless ?subshellId= or ?drafts=only)",
      },
    },
  );
