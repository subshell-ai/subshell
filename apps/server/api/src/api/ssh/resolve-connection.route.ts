import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshErrorCodeSchema, SshSnapshotSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh/ssh-actor.js";
import { sshResolve } from "@/services/ssh/ssh-connections.service.js";

/**
 * `POST /api/ssh/connections/resolve` (spec §4 row 2): one alias on a node,
 * answered as the reviewable outcome. A human act (policy `cookie_required`
 * for every machine credential), and the outcome DISCLOSES its named
 * limitations rather than silently narrowing the connection - which is why a
 * refusal is a 200 with a code, not a transport failure (the same grammar as
 * the wire outcome).
 */

const ResolveBodySchema = t.Object({
  nodeId: t.String({ description: "The connecting node to parse on" }),
  alias: t.String({ description: "The alias to resolve" }),
});

const ResolveViewSchema = t.Union([
  t.Object({
    accepted: t.Literal(true),
    snapshot: SshSnapshotSchema,
    connectingAccount: t.Optional(
      t.String({ description: "The connecting OS account, when the node could report it" }),
    ),
  }),
  t.Object({
    accepted: t.Literal(false),
    code: SshErrorCodeSchema,
    settings: t.Array(t.String({ description: "One config keyword that blocked" }), {
      description: "Config keywords that blocked, when the code names several",
    }),
  }),
]);

export const sshResolveConnectionRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/connections/resolve",
    async ({ body, user, actor, principal, apiKeyId, request }) => {
      assertCookieWriteOrigin(actor, request);
      return await sshResolve(await buildSshCaller({ actor, user, principal, apiKeyId }), body);
    },
    {
      body: ResolveBodySchema,
      response: {
        200: ResolveViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshResolveConfig",
        tags: ["ssh"],
        description:
          "Resolve one alias on a node into the approved snapshot for human review (a human action; a config the approved normalization cannot run - a proxy command, forwarding, a local command - is refused with the blocking keywords named, never silently narrowed)",
      },
    },
  );
