import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const NameBodySchema = t.Object({
  name: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 120,
      description: "New subshell display name (max 120 chars); locks the name",
    }),
  ),
  autoTitle: t.Optional(
    t.Boolean({
      description: "true = hand the name back to the pane-title auto-naming sweep; false = pin the current name",
    }),
  ),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/** `PATCH /api/subshells/:id/name` — renames a subshell. */
export const updateSubshellNameRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id/name",
    async ({ params, body, user, actor, principal, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      // requirePerm is scope-wide, not per-row: a subshell key holds
      // subshells:write for ITS subshell, so the cross-row check lives here
      // (same self-only rule as extend-token).
      if (actor === "subshell-key" && principal !== `sess:${params.id}`) {
        throw new HttpError(403, "A subshell token may only rename its own subshell");
      }
      if (body.name === undefined && body.autoTitle === undefined) {
        throw new HttpError(400, "Provide a name and/or an autoTitle flag");
      }
      // minLength only rejects ""; whitespace is trimmed here, and a name
      // that empties out is invalid — unlike notes, a subshell must have one.
      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name) {
          throw new HttpError(400, "Subshell name cannot be blank");
        }
        await ctx.services.subshells.renameSubshell(user.id, params.id, name, actor);
      }
      // Applied after the rename so a combined body decides the lock state
      // unambiguously: rename locks, autoTitle then overrides that choice.
      if (body.autoTitle !== undefined) {
        await ctx.services.subshells.setSubshellAutoTitle(user.id, params.id, body.autoTitle, actor);
      }
      return { ok: true } as const;
    },
    {
      body: NameBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateSubshellName",
        tags: ["subshells"],
        description: "Rename a subshell",
      },
    },
  );
