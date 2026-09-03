import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const ReplayBodySchema = t.Object({
  lines: t.Nullable(
    t.Integer({
      minimum: 1,
      maximum: 200,
      description:
        "Trailing log lines a terminal replays on attach (1–200); null = instance default (SUBSHELL_TERMINAL_REPLAY_LINES, 100)",
    }),
  ),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/**
 * `PATCH /api/subshells/:id/replay` — the per-subshell terminal history cap.
 * An `edit`-tier act (like rename/notes): the owner, an admin, or an
 * edit-grantee. Subshell bearer keys are refused here — this is a human
 * workspace setting, not something a running harness reconfigures.
 */
export const updateSubshellReplayRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id/replay",
    async ({ params, body, user, actor, ctx }) => {
      // Human config surface: a subshell bearer key never reconfigures its own
      // pane history. Passing null permissions makes requirePerm 403 any
      // subshell-key actor while cookie actors sail through.
      requirePerm({ actor, apiKeyPermissions: null }, "subshells", "write");
      await ctx.services.subshells.setSubshellReplayLines(user.id, params.id, body.lines, actor);
      return { ok: true } as const;
    },
    {
      body: ReplayBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setSubshellReplayLines",
        tags: ["subshells"],
        description: "Set the terminal attach-time history cap for this subshell (edit tier; null = default)",
      },
    },
  );
