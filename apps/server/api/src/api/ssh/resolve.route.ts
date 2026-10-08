import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { SshDestinationField, SshResolveOutcomeViewSchema, throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { apiModels } from "@/schema/index.js";
import { sshResolveDestination } from "@/services/ssh-launch.service.js";

/**
 * `POST /api/ssh/resolve` `{node, alias}` — resolve one destination token on
 * the connecting machine (`ssh -G` through the frozen engine) and answer the
 * OUTCOME.
 *
 * **A refusal is a 200 carrying `accepted: false`** (tier-1 grammar): "this
 * config needs a ProxyCommand" is a fact the human reads and goes and edits,
 * which settings blocked — not a transport error. The endpoint that ACTS
 * (`/launch`, saved-hosts PUT) is where a refusal-shaped outcome becomes a
 * 422; here nothing is launched and nothing is stored.
 *
 * Same gate as every ssh surface (row + owner, before any command), and the
 * destination takes the wire-grammar shape check FIRST: an unsafe token is
 * 400 and never reaches the machine.
 */
export const sshResolveRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/resolve",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, "SSH resolution is restricted to browser sessions");
      const answer = await sshResolveDestination(user.id, body.node, body.alias);
      if (!answer.ok) return throwCodedRefusal(answer.refusal);
      return answer.value;
    },
    {
      body: t.Object({
        node: t.String({ minLength: 1, description: "Node to resolve on ('local' = the control-plane host)" }),
        alias: SshDestinationField,
      }),
      response: {
        200: SshResolveOutcomeViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshResolveDestination",
        tags: ["ssh"],
        description:
          "Resolves one destination token into the approved connection snapshot (or the named refusal, which is a successful answer to read). Runs on the connecting machine; nothing is launched or stored by this call. Resolution evaluates the account's own SSH config with `ssh -G`; a `Match exec` hidden from the bounded config walk can run a local command during that evaluation, so approving a destination also approves running its resolution",
      },
    },
  );
