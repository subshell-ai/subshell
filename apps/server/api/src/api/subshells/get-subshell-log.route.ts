import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { SubshellLogTailSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { LOG_MAX_WINDOW_BYTES, LOG_WINDOW_DEFAULT_BYTES } from "@/services/nodes/log-tail.js";

/**
 * Cursor window (spec 2026-10-01 §3); absent `from_byte` keeps the EOF-anchored
 * tail. Out-of-range values CLAMP rather than refuse, the way every other
 * numeric surface on this app does (`replayLineCap`, the channels' `wait`); the
 * clamps live in `readLogCursor` and the description says so.
 */
const LogTailQuerySchema = t.Object({
  from_byte: t.Optional(
    t.Numeric({
      description:
        "Raw log-file offset to resume from (pass the previous response's nextByte); out-of-range values clamp (negative reads as 0, fractions truncate). Omitted = tail the last lines as before",
    }),
  ),
  max_bytes: t.Optional(
    t.Numeric({
      description: `Window budget for a cursor read, clamped into [1, ${LOG_MAX_WINDOW_BYTES}] (default ${LOG_WINDOW_DEFAULT_BYTES}); a line the window ended mid-way arrives whole on the next read unless it held no newline at all (longer than the budget, or still being written), which is returned partial so the cursor always advances`,
    }),
  ),
});

/** `GET /api/subshells/:id/log` — tail (or byte-cursor window) of the subshell's pane log. */
export const getSubshellLogRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/log",
    async ({ params, query, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      return await ctx.services.subshells.getSubshellLogTail(
        user.id,
        params.id,
        actor,
        query.from_byte === undefined && query.max_bytes === undefined
          ? undefined
          : { fromByte: query.from_byte, maxBytes: query.max_bytes },
      );
    },
    {
      query: LogTailQuerySchema,
      response: {
        200: SubshellLogTailSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        // Spec §5.6: the row's agent node has no live connection (409
        // NODE_OFFLINE, the create/restart mapping).
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSubshellLogTail",
        tags: ["subshells"],
        description:
          "Tail of the subshell's pane log (ANSI-stripped): why a harness exited, if it did. With from_byte, a window resumed from a prior nextByte instead",
      },
    },
  );
