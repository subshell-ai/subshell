import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const CreateSessionBodySchema = t.Object({
  profileId: t.String({ minLength: 1, description: "Profile to use for this session" }),
  workingDir: t.String({ minLength: 1, description: "Absolute working directory" }),
  name: t.Optional(t.String({ minLength: 1, maxLength: 120, description: "Session display name" })),
  prompt: t.Optional(
    t.String({ maxLength: 20000, description: "Task text typed into the pane once the harness settles" }),
  ),
  nodeId: t.Optional(
    t.String({ minLength: 1, description: "Node to launch on; omitted or 'local' = control-plane host" }),
  ),
});

/** Shared with restart (same response shape). */
export const CreateSessionResponseSchema = t.Object({
  id: t.String({ description: "New session id" }),
  tmuxSocket: t.String({ description: "tmux socket name" }),
  promptDelivered: t.Boolean({
    description: "Whether a creation prompt was typed into the pane (false when absent or the pane never settled)",
  }),
});

/** `POST /api/sessions` — creates a new agent session (starts the harness under tmux). */
export const createSessionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "write");
      // Phase 2 (spec §6.6): `nodeId` resolves for real — the service gates
      // the requested node (404/403/409), honors the profile pin, falls back
      // to `local` (its Everyone share is the switch), and auto-picks a lone
      // online agent. Bearer actors get the STRICT owner-only rule everywhere
      // on this path (no admin boost, no shares — a leaked harness key must
      // not spawn a control-plane session), hence `machineActor` below.
      return await ctx.services.sessions.createSession({
        userId: user.id,
        profileId: body.profileId,
        workingDir: body.workingDir,
        name: body.name,
        prompt: body.prompt,
        nodeId: body.nodeId,
        machineActor: actor !== "cookie",
      });
    },
    {
      body: CreateSessionBodySchema,
      response: {
        200: CreateSessionResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "createSession",
        tags: ["sessions"],
        description: "Creates a new agent session (starts the harness under tmux)",
      },
    },
  );
