import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { sshCallerSeed } from "@/services/pane-ssh-gate.js";

/**
 * The SSH-pane OPERATIONS on the existing pane family: the read-only
 * terminal-exec status door (`GET /:id/execs/:execId`, the REST door the MCP
 * `get_terminal_execution` tool rides) and the human takeover/return act
 * (`POST /:id/ssh-control`, `SshPaneControlRequest`/`SshControlView`). The two
 * endpoints share ONE module for the reason `routes.ts` documents and
 * `subshell-shares.route.ts` demonstrates: `App = ReturnType<typeof
 * createApp>` sits at Elysia's type-instantiation depth ceiling (TS2589), and
 * two extra `.use()` links on the subshells chain trip it where one does not
 * (measured: each alone compiles, the pair does not). One file, two endpoints,
 * one `.use()` - the sanctioned fold, not a style choice.
 */

/* ------------------------------------------------------------------ */
/* GET /:id/execs/:execId  (read-only terminal-exec status)             */
/* ------------------------------------------------------------------ */

/**
 * The frozen `SshTerminalExecView` (`services/ssh/ssh-api-types.ts`) spelled
 * as this route's `t` schema - co-location puts each route's schemas beside
 * its handler.
 */
const TerminalExecViewSchema = t.Object({
  id: t.String({ description: "Execution id (uuid; the recovery handle from the exec response)" }),
  subshellId: t.String({ description: "The pane the command was typed into" }),
  state: t.Union([t.Literal("outstanding"), t.Literal("completed"), t.Literal("unknown")], {
    description:
      "Observation state: outstanding = still being watched (not 'hung'; a caller's wait timing out leaves it HERE); completed = the marker landed and exitCode carries its rc; unknown = observation was lost (restart, death, budget) - reported as unknown, never renamed",
  }),
  exitCode: t.Nullable(t.Number({ description: "Marker-reported exit status; null unless completed" })),
  output: t.Nullable(
    t.String({ description: "Bounded captured output tail (newest kept); null until the record resolves" }),
  ),
  outputTruncated: t.Boolean({ description: "True when the tail dropped older lines to stay inside the cap" }),
  nextByte: t.Nullable(
    t.Number({
      description: "Log offset past the sentinel (or where observation stopped): the from_byte to continue from",
    }),
  ),
  inputGeneration: t.Number({
    description: "The pane's input generation at typing time (the takeover fence's receipt; 1 for ordinary panes)",
  }),
  createdAt: t.String({ description: "ISO 8601 typing time" }),
  resolvedAt: t.Nullable(t.String({ description: "ISO 8601 resolution time; null while outstanding" })),
});

/* ------------------------------------------------------------------ */
/* POST /:id/ssh-control  (human takeover / return)                     */
/* ------------------------------------------------------------------ */

/** Body per `SshPaneControlRequest` (the frozen `ssh-api-types.ts` shape). */
const SshPaneControlBodySchema = t.Object(
  {
    mode: t.Union([t.Literal("human"), t.Literal("agent")], {
      description:
        "The mode to move the pane's input control to: human = takeover (blocks agent reads and writes on every API/stream until returned); agent = return control (a human-only act: only humans return control to agents)",
    }),
  },
  { description: "The control transition to attempt" },
);

/** Response per `SshControlView` (generation already raised; stale queued input is fenced node-side). */
const SshControlViewSchema = t.Object({
  subshellId: t.String({ description: "The managed pane" }),
  controlOwner: t.Union([t.Literal("human"), t.Literal("agent")], {
    description: "Who holds input now after this transition",
  }),
  controlGeneration: t.Number({
    description:
      "The plane's authoritative input generation AFTER this transition; input and prompts below it are refused at the machine, and the pane's outstanding exec records moved to unknown",
  }),
});

/**
 * `GET /api/subshells/:id/execs/:execId` (SSH feature, spec §3): recover an
 * `exec_in_terminal` result by its execution ID. Read-only status - a status
 * read changes NOTHING about the command; its one side effect is re-arming
 * observation for an outstanding record whose watcher was lost, so a late
 * marker still lands. An id from another pane 404s exactly like one that
 * never existed.
 *
 * `POST /api/subshells/:id/ssh-control` (SSH feature): the human takeover /
 * return act for a MANAGED SSH terminal. Cookie session only (spec §2:
 * control changes are human configuration acts; machine credentials cannot
 * call them); the generation is the server's to raise, never the caller's to
 * choose. The pane must exist AND be managed - an ordinary pane 404s, because
 * takeover is not a control surface for panes that never had a control
 * boundary.
 */
export const sshPaneOpsRoutes = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/execs/:execId",
    async ({ params, user, principal, apiKeyId, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      return await ctx.services.subshells.getTerminalExecution(
        user.id,
        params.id,
        params.execId,
        sshCallerSeed({ user, actor, principal, apiKeyId }),
      );
    },
    {
      response: {
        200: TerminalExecViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getTerminalExecution",
        tags: ["subshells"],
        description:
          "Read one exec_in_terminal record by execution id (read-only recovery: outstanding/completed/unknown with the bounded tail; never a command mutation)",
      },
    },
  )
  .post(
    "/:id/ssh-control",
    async ({ params, body, user, principal, apiKeyId, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.takeSshControl(
        user.id,
        params.id,
        body.mode,
        sshCallerSeed({ user, actor, principal, apiKeyId }),
      );
    },
    {
      body: SshPaneControlBodySchema,
      response: {
        200: SshControlViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        503: "ApiErrorResponse",
      },
      detail: {
        operationId: "setSshPaneControl",
        tags: ["subshells"],
        description:
          "Take over or return input control of a managed SSH terminal (human cookie act; raises the input generation, fences stale queued input, invalidates outstanding exec records, and closes live subscriptions)",
      },
    },
  );
