import { LIST_SEARCH_MAX } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { matchesListQuery } from "@/api/list-filter.js";
import { SubshellSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

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
      return rows.filter(
        (s) =>
          (!query.nodeId || (s.nodeId || "local") === query.nodeId) &&
          matchesListQuery(query.q, s.name, s.workingDir, s.harnessId),
      );
    },
    {
      query: t.Object({
        q: t.Optional(t.String({ maxLength: LIST_SEARCH_MAX.subshells })),
        nodeId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
      }),
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
