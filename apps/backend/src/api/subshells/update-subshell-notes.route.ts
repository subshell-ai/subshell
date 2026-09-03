import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const NotesBodySchema = t.Object({
  notes: t.Union(
    [
      t.String({ maxLength: 2000, description: "Operator note for the subshell (max 2000 chars)" }),
      t.Null({ description: "Clears the note" }),
    ],
    { description: "Operator note or null to clear" },
  ),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/** `PATCH /api/subshells/:id/notes` — sets or clears a subshell note. */
export const updateSubshellNotesRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id/notes",
    async ({ params, body, user, actor, principal, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      // requirePerm is scope-wide, not per-row: a subshell key holds
      // subshells:write for ITS subshell, so the cross-row check lives here
      // (same self-only rule as extend-token).
      if (actor === "subshell-key" && principal !== `sess:${params.id}`) {
        throw new HttpError(403, "A subshell token may only write its own note");
      }
      return await ctx.services.subshells.updateSubshellNotes(user.id, params.id, body.notes, actor);
    },
    {
      body: NotesBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateSubshellNotes",
        tags: ["subshells"],
        description: "Set or clear a subshell note",
      },
    },
  );
