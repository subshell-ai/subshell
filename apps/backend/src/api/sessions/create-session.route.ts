import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
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
      // Phase-1 contract (spec 2026-08-31 §3): the column and the wire field
      // exist, but ONLY the control-plane host launches. Any other value —
      // whatever the node's id, visibility, or state — is refused here,
      // before any profile/service work. Nothing else about the node is
      // validated; remote launch (and its real gating) arrives in phase 2.
      if (body.nodeId !== undefined && body.nodeId !== "local") {
        throwApiError({
          code: BackendErrorCodes.NODE_LAUNCH_NOT_READY,
          message: "Remote launch arrives in phase 2",
          doNotLog: true,
        });
      }
      return await ctx.services.sessions.createSession({
        userId: user.id,
        profileId: body.profileId,
        workingDir: body.workingDir,
        name: body.name,
        prompt: body.prompt,
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
