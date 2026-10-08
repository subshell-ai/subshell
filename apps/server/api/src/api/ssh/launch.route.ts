import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { SubshellSchema } from "@/api/models.js";
import { SshDestinationField, SshResolveRefusalViewSchema, throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { sshLaunch } from "@/services/ssh-launch.service.js";

/**
 * `POST /api/ssh/launch` `{node, destination, name?}` — open an interactive
 * SSH pane to one destination (spec 2026-10-07 §5): gate (row + owner, before
 * anything), resolve the destination on the machine (the SAME path a discovery
 * answer takes; an unsafe token 400s first), refuse a refusal-shaped outcome
 * with **422 `{outcome}`** (the endpoint that acts does not carry a refusal in
 * a 200: a pane must never exist for a destination nobody approved), then
 * compose the config at the machine's derived path and launch the ssh harness
 * through the ordinary create path (presetless, working dir = the launch
 * node's home, auto-restart off by inheritance).
 *
 * No `prompt` field: an ssh launch types nothing (decision 7's compose:
 * reconnecting is not a task to submit). The audit `ssh.launch` lands after
 * the pane exists, never before.
 */
export const sshLaunchRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/launch",
    async ({ body, user, actor, ctx, status }) => {
      requireCookieActor(actor, "SSH launch is restricted to browser sessions");
      const answer = await sshLaunch({
        viewerId: user.id,
        nodeId: body.node,
        destination: body.destination,
        // The same label rule every human-chosen name takes (idempotent
        // through the manager's choke-point re-normalization).
        name: body.name === undefined ? undefined : normalizeLabel(body.name, 120),
        // RELAY MODE (spec 2026-10-08 §6): the key home whose agent signs,
        // gated and grant-matched inside the service. Absent = the M1 direct
        // launch. A first-use refusal answers 409 SSH_GRANT_APPROVAL_REQUIRED
        // and launches nothing (a durable approval row now stands).
        keyHomeNodeId: body.keyHome,
        subshells: ctx.services.subshells,
      });
      if (!answer.ok) {
        // The 422 is the ONE arm returned rather than thrown: its body is the
        // resolve outcome, not an error envelope. Everything else is a coded
        // refusal the handler maps with its standard status.
        const r = answer.refusal;
        if (r.status !== 422) return throwCodedRefusal(r);
        return status(422, { outcome: r.outcome });
      }
      const subshell = await ctx.services.subshells.getSubshell(user.id, answer.value.subshellId, actor);
      return status(201, { subshell });
    },
    {
      body: t.Object({
        node: t.String({ minLength: 1, description: "Connecting machine ('local' = the control-plane host)" }),
        destination: SshDestinationField,
        name: t.Optional(t.String({ minLength: 1, maxLength: 120, description: "Pane display name" })),
        keyHome: t.Optional(
          t.String({
            minLength: 1,
            description:
              "RELAY MODE: the key home machine whose agent signs for this connection; absent uses the connecting machine's own keys",
          }),
        ),
      }),
      response: {
        201: t.Object({ subshell: SubshellSchema }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        // The resolve refused: the body is the outcome, in the shape the
        // launcher screen already knows how to render from `/resolve`.
        422: t.Object({
          outcome: SshResolveRefusalViewSchema,
        }),
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshLaunchPane",
        tags: ["ssh"],
        description:
          "Opens an interactive SSH pane from the connecting machine to one approved destination. Owner-only and off by default; a destination whose resolution refused answers 422 carrying the outcome and launches nothing. Resolution evaluates the account's own SSH config with `ssh -G`; a `Match exec` hidden from the bounded config walk can run a local command during that evaluation, so approving a destination also approves running its resolution",
      },
    },
  );
