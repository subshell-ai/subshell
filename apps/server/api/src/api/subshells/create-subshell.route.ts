import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { VirtualDisplayRequestSchema } from "@/schema/virtual-display.js";

const CreateSubshellBodySchema = t.Object({
  harnessId: t.String({ minLength: 1, description: "Harness plugin id to launch" }),
  presetId: t.Optional(
    t.String({
      minLength: 1,
      description: "Preset to launch with; omitted = launch the harness with no saved settings",
    }),
  ),
  workingDir: t.Optional(
    t.String({
      minLength: 1,
      description:
        "Absolute working directory; omit only when the chosen preset carries one (the launch resolves the pair and 400s when neither does)",
    }),
  ),
  name: t.Optional(t.String({ minLength: 1, maxLength: 120, description: "Subshell display name" })),
  prompt: t.Optional(
    t.String({ maxLength: 20000, description: "Task text typed into the pane once the harness settles" }),
  ),
  nodeId: t.Optional(
    t.String({ minLength: 1, description: "Node to launch on; omitted or 'local' = control-plane host" }),
  ),
  workspaceId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 128,
      description:
        "Workspace to file the new subshell in: a tab row is written for it beside the launch. 404 when it is not the caller's (or absent). Omitted = the pane starts ungrouped",
    }),
  ),
  screen: t.Optional(t.Nullable(VirtualDisplayRequestSchema)),
});

/** Shared with restart (same response shape). */
export const CreateSubshellResponseSchema = t.Object({
  id: t.String({ description: "New subshell id" }),
  tmuxSocket: t.String({ description: "tmux socket name" }),
  promptDelivered: t.Boolean({
    description:
      "Whether a creation (or restart) prompt was typed into the pane (false when absent, blank, or the pane never settled)",
  }),
});

/** `POST /api/subshells` — creates a new agent subshell (starts the harness under tmux). */
export const createSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user, actor, principal, apiKeyPermissions, systemKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      // Phase 2 (spec §6.6): `nodeId` resolves for real — the service gates
      // the requested node (404/403/409), falls back to `local` (its Everyone
      // share is the switch), and auto-picks a lone online agent. Bearer
      // actors get the STRICT owner-only rule everywhere on this path (no
      // admin boost, no shares — a leaked harness key must not spawn a
      // control-plane subshell), hence `machineActor` below.
      // Normalized at the door (the shared label rule) so the recent-path
      // label below the launch carries the same string the row does; the
      // manager re-normalizes as the choke point, which is idempotent. An
      // optional name that normalizes to nothing stays an unnamed create —
      // it never was a 400 and is not one now.
      // The workspace a create is filed into must be the CALLER'S, checked
      // before anything spawns: an ownership miss reads as 404 like every
      // other workspace surface, so this endpoint never confirms someone
      // else's workspace id. Workspaces themselves stay cookie-only territory;
      // this is the one seam where the subshells door (open to bearer) touches
      // one, and it is deliberate: a pane-token create resolving as its owner
      // could file its OWN sibling into the owner's arrangement, which is the
      // same altitude as the sibling acts the security model already accepts.
      if (body.workspaceId !== undefined) {
        const workspace = await ctx.repos.workspaces.findByIdForUser(body.workspaceId, user.id);
        if (!workspace) throw new HttpError(404, "Workspace not found");
      }
      return await ctx.services.subshells.createSubshell({
        systemKeyPermissions,
        userId: user.id,
        harnessId: body.harnessId,
        presetId: body.presetId,
        workingDir: body.workingDir,
        name: body.name === undefined ? undefined : normalizeLabel(body.name, 120),
        prompt: body.prompt,
        nodeId: body.nodeId,
        workspaceId: body.workspaceId,
        screen: body.screen,
        machineActor: actor !== "cookie",
        // A launch that arrives on a PANE'S OWN token is an agent opening a
        // sibling to talk to it (`create_subshell`); a system key is admin
        // automation, not an in-pane peer. Only the former files as
        // cross-agent comms and (in the service) skips the default bell.
        crossAgent: actor === "subshell-key",
        parentSubshellId: actor === "subshell-key" ? principal.slice("sess:".length) : null,
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
      systemPermission: "subshells:execute",
      detail: {
        operationId: "createSubshell",
        tags: ["subshells"],
        description: "Creates a new agent subshell (starts the harness under tmux)",
      },
    },
  );
