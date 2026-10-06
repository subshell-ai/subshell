import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { SshErrorCodeSchema, SshSnapshotSchema } from "@/api/ssh-runtime/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { sshDiscovery, sshResolve } from "@/services/ssh-runtime/discovery.service.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh-runtime/ssh-actor.js";

/**
 * `/api/ssh-runtime/discovery` and `/api/ssh-runtime/resolve` (design
 * 2026-10-05 §7's selection UX): the two node-scoped reads the Connect-over-
 * SSH wizard needs BEFORE a session exists - the alias list discovered on the
 * caller's own machine, and the concrete `host:port user` a chosen alias
 * resolves to. They are the same node RPC the old admin door rode (the
 * salvage rule: the adapter is reused, not re-forked), reached through the
 * SAME eligibility implementation `sshNodeGate` provides - real owner, no
 * admin boost, no share; a foreign node 404s exactly like a missing one.
 *
 * The human gate is the whole product rule here: these acts belong to every
 * signed-in person, not to admins and not to machine credentials.
 * `requireCookieActor` refuses bearers with 403 at the route; the policy's
 * own cookie arm stands behind it for defense in depth.
 *
 * These endpoints ride the existing `/api/ssh-runtime` aggregate rather than
 * a new `.use()` link because the ssh basket's comment records the reason: a
 * new sub-aggregate on the machine-side group re-trips the TS2589 depth
 * ceiling; endpoints fold into what is already mounted.
 */

/** The 403 machine credentials get on this family (mirrors the sessions route's line). */
const HUMAN_ONLY = "SSH connections are managed from the browser by a signed-in person.";

const DiscoveryQuerySchema = t.Object({
  nodeId: t.String({ description: "The connecting node to parse the account's SSH config on" }),
});

const DiscoveryViewSchema = t.Object({
  aliases: t.Array(t.String({ description: "One alias name" }), {
    description: "Alias names, sorted, wildcard-only excluded",
  }),
  includeCycle: t.Boolean({ description: "An include cycle was detected during the bounded parse" }),
  truncated: t.Boolean({ description: "The alias cap was hit; more exist" }),
});

const ResolveBodySchema = t.Object({
  nodeId: t.String({ description: "The connecting node to parse on" }),
  alias: t.String({ description: "The alias to resolve" }),
});

const ResolveViewSchema = t.Union([
  t.Object({
    accepted: t.Literal(true, { description: "The alias normalized into reviewable destination facts" }),
    snapshot: SshSnapshotSchema,
    connectingAccount: t.Optional(
      t.String({ description: "The connecting OS account, when the node could report it" }),
    ),
  }),
  t.Object({
    accepted: t.Literal(false, { description: "Resolution refused; the code names the limitation" }),
    code: SshErrorCodeSchema,
    settings: t.Array(t.String({ description: "One config keyword that blocked" }), {
      description: "Config keywords that blocked, when the code names several",
    }),
  }),
]);

export const sshRuntimeNodeVerbRoutes = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/discovery",
    async ({ query, user, actor, principal, apiKeyId }) => {
      requireCookieActor(actor, HUMAN_ONLY);
      return await sshDiscovery(await buildSshCaller({ actor, user, principal, apiKeyId }), query.nodeId);
    },
    {
      query: DiscoveryQuerySchema,
      response: {
        200: DiscoveryViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimeDiscovery",
        tags: ["ssh-runtime"],
        description: "SSH config alias names on a node the caller owns (names only, never config contents)",
      },
    },
  )
  .post(
    "/resolve",
    async ({ body, user, actor, principal, apiKeyId, request }) => {
      requireCookieActor(actor, HUMAN_ONLY);
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
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshRuntimeResolve",
        tags: ["ssh-runtime"],
        description:
          "Resolve one alias on an owned node into the concrete destination the session open will carry (a refusal is a 200 with a named code)",
      },
    },
  );
