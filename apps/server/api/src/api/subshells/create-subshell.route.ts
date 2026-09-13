import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const CreateSubshellBodySchema = t.Object({
  harnessId: t.String({ minLength: 1, description: "Harness plugin id to launch" }),
  presetId: t.Optional(
    t.String({
      minLength: 1,
      description: "Preset to launch with; omitted = launch the harness with no saved settings",
    }),
  ),
  workingDir: t.String({ minLength: 1, description: "Absolute working directory" }),
  name: t.Optional(t.String({ minLength: 1, maxLength: 120, description: "Subshell display name" })),
  prompt: t.Optional(
    t.String({ maxLength: 20000, description: "Task text typed into the pane once the harness settles" }),
  ),
  nodeId: t.Optional(
    t.String({ minLength: 1, description: "Node to launch on; omitted or 'local' = control-plane host" }),
  ),
});

/** Shared with restart (same response shape). */
export const CreateSubshellResponseSchema = t.Object({
  id: t.String({ description: "New subshell id" }),
  tmuxSocket: t.String({ description: "tmux socket name" }),
  promptDelivered: t.Boolean({
    description: "Whether a creation prompt was typed into the pane (false when absent or the pane never settled)",
  }),
});

/** `POST /api/subshells` — creates a new agent subshell (starts the harness under tmux). */
export const createSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      // Phase 2 (spec §6.6): `nodeId` resolves for real — the service gates
      // the requested node (404/403/409), falls back to `local` (its Everyone
      // share is the switch), and auto-picks a lone online agent. Bearer actors get the STRICT owner-only rule everywhere
      // on this path (no admin boost, no shares — a leaked harness key must
      // not spawn a control-plane subshell), hence `machineActor` below.
      return await ctx.services.subshells.createSubshell({
        userId: user.id,
        harnessId: body.harnessId,
        presetId: body.presetId,
        workingDir: body.workingDir,
        name: body.name,
        prompt: body.prompt,
        nodeId: body.nodeId,
        machineActor: actor !== "cookie",
      });
    },
    {
      body: CreateSubshellBodySchema,
      response: {
        200: CreateSubshellResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "createSubshell",
        tags: ["subshells"],
        description: "Creates a new agent subshell (starts the harness under tmux)",
      },
    },
  );
