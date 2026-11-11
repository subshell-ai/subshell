import { ApiError } from "@internal/backend-errors";
import { getHarness, type HarnessSubagentSnapshot } from "@internal/pane-runtime";
import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { HarnessSubagents } from "@/modules/subshells/harness-subagents.js";
import { SubshellError } from "@/modules/subshells/subshells.service.js";
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

/**
 * One picker act per pane at a time. A pane driver types into the pane's
 * own UI and then reads it back, so two overlapping clicks would interleave
 * their keystrokes. A restart checks the generation again before accepting
 * the result; the lock itself stays keyed by pane id so the old act still
 * owns it until it finishes.
 */
const selecting = new Set<string>();

/**
 * Why this caller may not drive an integration's own picker, or undefined
 * when it may. That path types into the pane, so it needs `edit` (and the ssh
 * owner/kind rule), plus the `subshells:execute` ceiling the select door
 * itself enforces for scoped system keys. The extension bridge's queued
 * command stays open to viewers.
 */
function nativeSelectRefusal(
  row: { access: string; ssh: boolean },
  actor: string,
  systemPermissions: string[] | null | undefined,
): string | undefined {
  if (actor === "subshell-key") return "Subshell keys cannot change the shared view.";
  if (actor === "system-key" && systemPermissions !== null && !systemPermissions?.includes("subshells:execute"))
    return "This key needs the subshells:execute permission.";
  if (row.ssh && (actor !== "cookie" || row.access !== "owner"))
    return "SSH panes only accept input from the owner's browser session.";
  if (row.access !== "owner" && row.access !== "edit")
    return "Switching this harness's view types into the pane, so it needs edit access.";
  return undefined;
}

/**
 * An integration with its own pane driver answers navigation without a bridge
 * heartbeat. Its snapshot's `canSelect` is therefore the plugin declaration,
 * bounded by the caller's own edit/ssh authority; the 15 s silence gate
 * belongs to bridges that only queue a command and would rot once they
 * stopped polling.
 */
function withNativeSelection(
  snapshot: HarnessSubagentSnapshot,
  harnessId: string,
  alive: boolean,
  refusal: string | undefined,
): HarnessSubagentSnapshot {
  if (!alive) return snapshot;
  const support = getHarness(harnessId)?.subagents;
  if (!support?.select) return snapshot;
  return refusal === undefined
    ? { ...snapshot, canSelect: true, unavailableReason: undefined }
    : { ...snapshot, canSelect: false, unavailableReason: refusal };
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
 * are). Extension-backed selection changes the parent's SHARED view and stays
 * open to anyone who may watch the pane; an integration that types into
 * the harness's own picker needs edit, plus the ssh owner rule. `report` is the
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
    async ({ user, actor, apiKeyPermissions, systemKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      const rows = await ctx.services.subshells.listSubshells(user.id, { previews: false });
      return Object.fromEntries(
        rows.map((row) => [
          row.id,
          withNativeSelection(
            registry(ctx.db).read(row.id, row.startedAt ?? "", row.status === "running" && row.alive === true),
            row.harnessId,
            row.status === "running" && row.alive === true,
            nativeSelectRefusal(row, actor, systemKeyPermissions),
          ),
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
    async ({ params, user, actor, apiKeyPermissions, systemKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      const row = await ctx.services.subshells.getSubshell(user.id, params.id, actor);
      return withNativeSelection(
        registry(ctx.db).read(row.id, row.startedAt ?? "", row.status === "running" && row.alive === true),
        row.harnessId,
        row.status === "running" && row.alive === true,
        nativeSelectRefusal(row, actor, systemKeyPermissions),
      );
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
      // This changes the shared view, not the agent's work. A queued command
      // stays open to viewers; a pane driver requires edit because it types
      // into the pane.
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      if (actor === "subshell-key") throw new HttpError(403, "Subshell keys cannot change the shared agent view");
      const row = await ctx.services.subshells.getSubshell(user.id, params.id, actor);
      if (row.status !== "running" || row.alive !== true) {
        throw new HttpError(409, "This subagent view isn't available. Use the harness's own agent selector.");
      }
      const generation = row.startedAt ?? "";
      const state = registry(ctx.db).read(row.id, generation, true);
      const support = getHarness(row.harnessId)?.subagents;
      if (support?.select) {
        // An integration with a pane driver runs its harness's own picker or
        // inspector in the pane. It verifies the row it selected and returns
        // that id; a bridge that only queues commands keeps the report loop.
        if (body.agentId !== null && !state.agents.some((agent) => agent.id === body.agentId)) {
          throw new HttpError(409, "This subagent view isn't available. Use the harness's own agent selector.");
        }
        const lock = row.id;
        if (selecting.has(lock)) {
          throw new HttpError(409, "Another agent switch is still in progress. Wait for it to finish.");
        }
        selecting.add(lock);
        try {
          const hadRoster = state.agents.length > 0;
          const pane = await ctx.services.subshells.harnessSubagentPane(user.id, params.id, actor);
          const result = await support.select({ agentId: body.agentId, agents: state.agents, pane });
          const recorded = registry(ctx.db).markSelected(row.id, generation, result.selectedId);
          if (!recorded) {
            // A quiet pane has no state at all; the plugin's own short-circuit
            // proves the parent view, so a null return is a no-op success. Use
            // the pre-act roster: re-reading with this generation would delete
            // a restarted run's newer state.
            if (result.selectedId !== null || hadRoster) {
              throw new HttpError(409, "The pane changed while switching agents. Try again.");
            }
          }
          return { ok: true } as const;
        } catch (err) {
          // Preserve the service's own refusals (404 invisible, 403 ssh,
          // node offline, maintenance) instead of flattening them into a
          // generic picker failure.
          if (err instanceof HttpError || err instanceof ApiError || err instanceof SubshellError) throw err;
          throw new HttpError(409, "The harness didn't switch views. Use its own agent selector.");
        } finally {
          selecting.delete(lock);
        }
      }
      if (!registry(ctx.db).select(row.id, generation, body.agentId)) {
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
        description: "Switch the parent's terminal view to one of its reported children",
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
