import { LIST_SEARCH_MAX } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { matchesListQuery } from "@/api/list-filter.js";
import { SubshellSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const ListSubshellsQuerySchema = t.Object({
  q: t.Optional(t.String({ maxLength: LIST_SEARCH_MAX.subshells })),
  nodeId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  workspace: t.Optional(
    t.String({
      minLength: 4,
      maxLength: 128,
      // Floor 4 on both spellings of the rule: the `none` word IS four
      // characters, and no id this filter could name is shorter, so the
      // pattern and `minLength` agree instead of one silently overriding
      // the other (review 2026-10-17).
      pattern: "^(none|[0-9a-zA-Z_-]{4,128})$",
      description:
        "Filter by workspace membership: 'none' for the caller's ungrouped subshells (the rail's Ungrouped section), or a workspace id for its members. An id the caller does not have simply answers empty — same posture as nodeId, and no existence oracle",
    }),
  ),
});

/** `GET /api/subshells` — lists the authenticated user's subshells. */
export const listSubshellsRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ user, actor, apiKeyPermissions, ctx, query }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      // bearer enumeration is deliberate (MCP coordination sees owner-shared
      // siblings); boundary pinned by __tests__ (subshells-list-visibility
      // .test.ts, enumerate-ok / act-denied) — do not tighten without
      // updating docs/security.md §3.
      const rows = await ctx.services.subshells.listSubshells(user.id);
      // Membership comes from the CALLER'S workspaces only (a workspace is
      // private, so "ungrouped" means "in nothing I can see"). A pane shared
      // INTO me that its owner filed in THEIR workspace still reads as
      // ungrouped here — the other user's arrangement is not information this
      // list ever carries.
      const membership = query.workspace ? await ctx.repos.workspacePanes.listMembershipForUser(user.id) : [];
      const filedElsewhere = new Set(membership.map((m) => m.subshellId));
      const inNamed = new Set(membership.filter((m) => m.workspaceId === query.workspace).map((m) => m.subshellId));
      return rows.filter(
        (s) =>
          (!query.nodeId || (s.nodeId || "local") === query.nodeId) &&
          (query.workspace === undefined ||
            (query.workspace === "none" ? !filedElsewhere.has(s.id) : inNamed.has(s.id))) &&
          matchesListQuery(query.q, s.name, s.workingDir, s.harnessId),
      );
    },
    {
      query: ListSubshellsQuerySchema,
      response: {
        200: t.Array(SubshellSchema, { description: "User's subshells" }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSubshells",
        tags: ["subshells"],
        description: "Lists the authenticated user's subshells",
      },
    },
  );
