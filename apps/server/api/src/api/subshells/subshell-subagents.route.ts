import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { HarnessSubagents } from "@/modules/subshells/harness-subagents.js";
import { HttpError } from "@/shared/errors.js";

// One registry per database context. The WeakMap key is the app's `ctx.db`;
// per-file test isolation comes from each test file's fresh module registry.
const registries = new WeakMap<object, HarnessSubagents>();
function registry(context: object): HarnessSubagents {
  let value = registries.get(context);
  if (!value) {
    value = new HarnessSubagents();
    registries.set(context, value);
  }
  return value;
}

const identifier = t.String({
  minLength: 1,
  maxLength: 256,
  description: "Harness-side agent identifier, exactly as the harness reports it",
});
/** Elysia's t.Optional/t.Nullable take no trailing options; describe the STRING. */
const identifierAs = (description: string) => t.String({ minLength: 1, maxLength: 256, description });
// The reported fields an agent is built from, shared by the report body and
// the served view so the two can never drift apart on shape.
const agentProps = {
  id: identifier,
  parentId: t.Optional(identifierAs("Parent agent within the harness, when it nests")),
  name: t.String({
    minLength: 1,
    maxLength: 160,
    description: "Display name as reported; generic ones render numbered",
  }),
  status: t.Union([t.Literal("running"), t.Literal("waiting"), t.Literal("idle")], {
    description: "What the harness says the agent is doing",
  }),
  activity: t.Optional(
    t.String({ maxLength: 160, description: "One-line task label in the harness's own words, when it has one" }),
  ),
};
/** What a harness may report about one child. `startedAt` is the server's own stamp, never input. */
const ReportAgentSchema = t.Object(agentProps);
const ViewAgentSchema = t.Object({
  ...agentProps,
  startedAt: t.Number({ description: "Epoch ms of when the server first saw this child; derive elapsed from it" }),
});
const SnapshotSchema = t.Object({
  agents: t.Array(ViewAgentSchema, { description: "Reported children with server stamps, bounded to 256" }),
  selectedId: t.Nullable(identifierAs("The child the PARENT's terminal is showing, if any")),
  canSelect: t.Boolean({ description: "Whether this actor may move the parent's view; false with a reason when not" }),
  unavailableReason: t.Optional(t.String({ maxLength: 256, description: "Why selection is unavailable" })),
});
const SubagentSelectBodySchema = t.Object({
  agentId: t.Union([identifier, t.Null()], {
    description: "Child to show in the parent's terminal, or null to return to the main agent",
  }),
});
const SubagentReportBodySchema = t.Object({
  event: t.Union(
    [t.Literal("snapshot"), t.Literal("start"), t.Literal("stop"), t.Literal("reset"), t.Literal("describe")],
    {
      description:
        "snapshot replaces the roster; start/stop adjust it; describe parks a task label for the next child of that type; reset (a cleared or forked conversation) discards it",
    },
  ),
  agents: t.Optional(
    t.Array(ReportAgentSchema, { maxItems: 256, description: "The roster for snapshot/start reports" }),
  ),
  agentId: t.Optional(identifierAs("The agent a start, stop, or exact describe report names")),
  agentType: t.Optional(t.String({ maxLength: 160, description: "Which kind of agent a describe label belongs to" })),
  activity: t.Optional(t.String({ maxLength: 160, description: "One-line task label from a describe report" })),
  agentName: t.Optional(t.String({ maxLength: 160, description: "The name assigned when spawning a subagent" })),
  selectedId: t.Optional(
    t.Union([identifier, t.Null()], { description: "The parent's current view, per the harness" }),
  ),
  canSelect: t.Optional(t.Boolean({ description: "Whether the harness can honor view switches" })),
  unavailableReason: t.Optional(t.String({ maxLength: 256, description: "Why the harness cannot switch views" })),
  acknowledged: t.Optional(identifierAs("Id of the pending command the harness just carried out")),
});
const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });
const ReportResponseSchema = t.Object({
  command: t.Optional(
    t.Object(
      {
        id: identifier,
        agentId: t.Nullable(identifierAs("Where to switch, or null for the main agent")),
      },
      { description: "The parent's pending view command, for the harness to carry out and acknowledge" },
    ),
  ),
});

/**
 * `/api/subshells/:id/subagents*`: the harness subagents surface. Reads are
 * ordinary visibility-filtered reads (viewer sees what the parent's children
 * are); `select` changes the parent's SHARED view, so it stays open to anyone
 * who may watch the pane, while typing still requires edit. `report` is the
 * fourth harness self-report surface (with attention, harness-session, and
 * exit): the route accepts ONLY the subshell's own key, checked before any row
 * is read, and a harness reports about itself, never another subshell. State
 * is in-memory and transient: after a plane or pane restart the harness
 * re-reports from scratch.
 */
export const subshellSubagentsRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/subagents",
    async ({ user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      const rows = await ctx.services.subshells.listSubshells(user.id, { previews: false });
      return Object.fromEntries(
        rows.map((row) => [
          row.id,
          registry(ctx.db).read(row.id, row.startedAt ?? "", row.status === "running" && row.alive === true),
        ]),
      );
    },
    {
      response: {
        200: t.Record(t.String(), SnapshotSchema, {
          description: "Snapshot per visible subshell, empty for quiet ones",
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      systemPermission: "subshells:read",
      detail: {
        operationId: "getHarnessSubagentStates",
        tags: ["subshells"],
        description: "Batch read of reported subagents for every visible subshell",
      },
    },
  )
  .get(
    "/:id/subagents",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      const row = await ctx.services.subshells.getSubshell(user.id, params.id, actor);
      return registry(ctx.db).read(row.id, row.startedAt ?? "", row.status === "running" && row.alive === true);
    },
    {
      response: {
        200: SnapshotSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      systemPermission: "subshells:read",
      detail: {
        operationId: "getSubshellHarnessSubagents",
        tags: ["subshells"],
        description: "Reported subagents of one subshell",
      },
    },
  )
  .post(
    "/:id/subagents/select",
    async ({ params, body, user, actor, apiKeyPermissions, ctx }) => {
      // This changes the shared view, not the agent's work. Viewers may navigate;
      // they still cannot type, stop, steer, or answer approval prompts.
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      if (actor === "subshell-key") throw new HttpError(403, "Subshell keys cannot change the shared agent view");
      const row = await ctx.services.subshells.getSubshell(user.id, params.id, actor);
      if (
        row.status !== "running" ||
        row.alive !== true ||
        !registry(ctx.db).select(row.id, row.startedAt ?? "", body.agentId)
      ) {
        throw new HttpError(409, "This subagent view isn't available. Use the harness's own agent selector.");
      }
      return { ok: true } as const;
    },
    {
      body: SubagentSelectBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "selectHarnessSubagent",
        tags: ["subshells"],
        description: "Queue a switch of the parent's terminal view to one of its reported children",
      },
    },
  )
  .post(
    "/:id/subagents/report",
    async ({ params, body, actor, principal, apiKeyId, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      if (actor !== "subshell-key" || principal !== `sess:${params.id}`) {
        throw new HttpError(403, "Only a subshell's own key may report its subagents");
      }
      const row = await ctx.repos.subshells.findById(params.id);
      // Restart may rotate the key while authentication is in flight.
      if (!row || row.apiKeyId !== apiKeyId) throw new HttpError(403, "This subshell key is no longer current");
      if (row.status !== "running" || row.alive !== 1) throw new HttpError(409, "This subshell is no longer running");
      // Pane-reported text is a NAME path like any other: it renders in the
      // sidebar and header of the owner AND every viewer, so it goes through
      // normalizeLabel before it is ever stored (control characters, escapes
      // and format characters dropped, NFC, capped).
      return registry(ctx.db).report(row.id, row.startedAt ?? "", {
        ...body,
        ...(body.agents
          ? {
              agents: body.agents.map((agent) => ({
                ...agent,
                name: normalizeLabel(agent.name, 160),
                ...(agent.activity !== undefined ? { activity: normalizeLabel(agent.activity, 160) } : {}),
              })),
            }
          : {}),
        ...(body.unavailableReason !== undefined
          ? { unavailableReason: normalizeLabel(body.unavailableReason, 256) }
          : {}),
        // The describe pair is pane-reported text like the names beside it.
        ...(body.agentName !== undefined ? { agentName: normalizeLabel(body.agentName, 160) } : {}),
        ...(body.agentType !== undefined ? { agentType: normalizeLabel(body.agentType, 160) } : {}),
        ...(body.activity !== undefined ? { activity: normalizeLabel(body.activity, 160) } : {}),
      });
    },
    {
      body: SubagentReportBodySchema,
      response: {
        200: ReportResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "reportHarnessSubagents",
        tags: ["subshells"],
        description: "Harness self-report of its own subagents (the pane's own key only)",
      },
    },
  );
