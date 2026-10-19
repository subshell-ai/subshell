import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { HarnessSubagents } from "@/services/harness-subagents.js";

// A separate registry per application context, including isolated test servers.
const registries = new WeakMap<object, HarnessSubagents>();
function registry(context: object): HarnessSubagents {
  let value = registries.get(context);
  if (!value) {
    value = new HarnessSubagents();
    registries.set(context, value);
  }
  return value;
}
const identifier = t.String({ minLength: 1, maxLength: 256 });
const agent = t.Object({
  id: identifier,
  parentId: t.Optional(identifier),
  name: t.String({ minLength: 1, maxLength: 160 }),
  status: t.Union([t.Literal("running"), t.Literal("waiting"), t.Literal("idle")]),
});

export const subshellSubagentsRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .get("/subagents", async ({ user, actor, apiKeyPermissions, ctx }) => {
    requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
    const rows = await ctx.services.subshells.listSubshells(user.id, { previews: false });
    return Object.fromEntries(
      rows.map((row) => [
        row.id,
        registry(ctx.db).read(row.id, row.startedAt ?? "", row.status === "running" && row.alive === true),
      ]),
    );
  })
  .get("/:id/subagents", async ({ params, user, actor, apiKeyPermissions, ctx }) => {
    requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
    const row = await ctx.services.subshells.getSubshell(user.id, params.id, actor);
    return registry(ctx.db).read(row.id, row.startedAt ?? "", row.status === "running" && row.alive === true);
  })
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
      return { ok: true };
    },
    { body: t.Object({ agentId: t.Union([identifier, t.Null()]) }) },
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
      return registry(ctx.db).report(row.id, row.startedAt ?? "", body);
    },
    {
      body: t.Object({
        event: t.Union([t.Literal("snapshot"), t.Literal("start"), t.Literal("stop"), t.Literal("reset")]),
        agents: t.Optional(t.Array(agent, { maxItems: 256 })),
        agentId: t.Optional(identifier),
        selectedId: t.Optional(t.Union([identifier, t.Null()])),
        canSelect: t.Optional(t.Boolean()),
        unavailableReason: t.Optional(t.String({ maxLength: 256 })),
        acknowledged: t.Optional(identifier),
      }),
    },
  );
