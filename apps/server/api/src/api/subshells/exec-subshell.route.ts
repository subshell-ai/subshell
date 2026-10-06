import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { EXEC_TIMEOUT_MAX, EXEC_TIMEOUT_MIN, EXEC_TIMEOUT_MS } from "@/services/nodes/pane-exec.js";

/**
 * One shell command, run in a TERMINAL pane, answered with its output and
 * exit code (spec 2026-10-02). The sentinel protocol and every refusal that
 * types nothing live in the service; this file is shape only. `timeoutMs` is
 * CLAMPED by the service, not refused out of range: a caller asking 1 ms or
 * 99 hours still means "run it". The schema carries no min/max on purpose -
 * the service is the single clamp authority, and a route that pre-refused
 * values the service would pull in would contradict it.
 */
const ExecBodySchema = t.Object(
  {
    command: t.String({
      minLength: 1,
      maxLength: 20000,
      description: "The shell command line, typed verbatim through the same keystroke seam as pane input",
    }),
    timeoutMs: t.Optional(
      t.Number({
        description: `How long to wait for the shell's sentinel before answering timed_out (default ${EXEC_TIMEOUT_MS}; clamped ${EXEC_TIMEOUT_MIN}..${EXEC_TIMEOUT_MAX}; a timeout never touches the pane)`,
      }),
    ),
  },
  { description: "One command to run in a terminal pane's shell" },
);

const ExecResultSchema = t.Object({
  status: t.Union([t.Literal("completed"), t.Literal("timed_out")], {
    description:
      "completed: the sentinel arrived and exitCode is the command's status; timed_out: it did not, nothing further was typed",
  }),
  exitCode: t.Nullable(
    t.Number({ description: "The shell's status for the command; null unless status is completed" }),
  ),
  output: t.String({
    description:
      "The pane's lines from before the command until the sentinel (includes the shell's echo of the typed command); newest-kept past the cap",
  }),
  truncated: t.Boolean({ description: "True when output dropped older lines to stay inside the 256 KiB cap" }),
  nextByte: t.Number({
    description:
      "Raw log offset just after the sentinel line (or where the wait stopped); pass it as read_subshell_log's from_byte to continue exactly",
  }),
});

/**
 * `POST /api/subshells/:id/exec` (spec 2026-10-02). Gates mirror the input
 * route (an `edit` act; view 403, foreign 404, bearer as owner), plus: the
 * pane must run a `terminal`-type harness (400 EXEC_TERMINAL_ONLY - an agent
 * pane would read the line into its own input), the pane must be quiet first
 * (409 EXEC_PANE_BUSY, nothing typed), and one exec at a time per pane
 * (409 EXEC_IN_FLIGHT). A `timed_out` 200 is a SUCCESS response by ruling: a
 * slow build is not an error path.
 */
export const execSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/exec",
    async ({ params, body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.execInTerminal(user.id, params.id, body.command, body.timeoutMs, actor);
    },
    {
      body: ExecBodySchema,
      response: {
        200: ExecResultSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "execSubshell",
        tags: ["subshells"],
        description:
          "Run one command in a terminal pane's shell and return its output and exit code (an edit act; refusals type nothing)",
      },
    },
  );
