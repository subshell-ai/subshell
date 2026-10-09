import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { SshAgentIdentityViewSchema, SshGrantViewSchema, throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { listGrants, revokeGrant, updateGrant } from "@/services/ssh-grants.service.js";
import { listNodeAgentIdentities, sshCreateGrant } from "@/services/ssh-launch.service.js";

/**
 * `GET|POST /api/ssh/grants`, `PATCH|DELETE /api/ssh/grants/:id` - the grants
 * screen (spec 2026-10-08 §6, §8): list, create, edit the selector/name, and
 * revoke. The rows are per-owner exactly like the saved-hosts ledger they sit
 * beside: a foreign id answers the SAME 404 an absent one does (ids are never
 * existence oracles, docs/security.md §3), no list carries another owner's
 * rows, and the cookie doctrine is the siblings' verbatim (`requireCookieActor`
 * - these routes decide which of the OWNER's keys may sign from which
 * machine, which is a browser-session act).
 *
 * Create runs the key home's gate (only a machine you may SSH through can be
 * your key home); the fingerprint SELECTION is immutable through PATCH by
 * design - widening which keys serve is a revoke plus a fresh grant, so
 * every standing selection has exactly the audit trail that chose it.
 * DELETE is the instant both-ways cut: the row goes and every live relay
 * that ran under it is torn down inside the service (spec §6.3).
 *
 * What the audit rows carry (written by the service, not here): ids, hosts,
 * and on the grant approve/create rows the CHOSEN fingerprint VALUES - the
 * public `SHA256:` identifiers, named because spec §10 makes those rows the
 * durable record of the operator's selection. Everywhere else the trail names
 * the COUNT only, no fingerprint value rides a log line or a notification,
 * and no row carries key material (docs/security.md §10).
 *
 * `GET /grants/identities?node=` is the roster-BY-NODE read (spec §8, Task
 * 18): the create picker's candidate list, the same §5.4 roster command the
 * approval screen asks, taken against a directly-chosen key home with NO
 * pending request standing. It writes nothing (not even an audit row), gates
 * through the key home's own gate before the machine is asked, and fails
 * closed by name when the key home is unreachable - an empty list means the
 * live agent holds nothing, never "we could not ask".
 */
export const sshGrantsRoutes = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/grants",
    async ({ user, actor }) => {
      requireCookieActor(actor, "SSH key grants are restricted to browser sessions");
      return { grants: await listGrants({ ownerUserId: user.id }) };
    },
    {
      response: {
        200: t.Object({
          grants: t.Array(SshGrantViewSchema, { description: "The caller's standing grants, newest first" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSshKeyGrants",
        tags: ["ssh"],
        description:
          "Lists the caller's key grants: which key home may sign for which destinations, and which selected agent identities carry that authorization",
      },
    },
  )
  .get(
    "/grants/identities",
    async ({ query, user, actor }) => {
      requireCookieActor(actor, "SSH key grants are restricted to browser sessions");
      const answer = await listNodeAgentIdentities({ viewerId: user.id, aNodeId: query.node });
      if (!answer.ok) return throwCodedRefusal(answer.refusal);
      return { identities: answer.value.identities };
    },
    {
      query: t.Object({
        node: t.String({
          minLength: 1,
          description: "Key home machine whose live agent roster to read (an agent node you own, SSH switched on)",
        }),
      }),
      response: {
        200: t.Object({
          identities: t.Array(SshAgentIdentityViewSchema, {
            description:
              "The key home's WHOLE public roster with the key blobs withheld; the picker selects the grant's subset (cap enforced on create, never by truncating this list)",
          }),
        }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSshNodeAgentIdentities",
        tags: ["ssh"],
        description:
          "Enumerates a chosen key home's live agent identities for the create picker (fingerprints plus comments, blobs withheld, no pending request needed); an offline or refusing key home answers a named error, never a fabricated empty roster, and the read writes no audit row",
      },
    },
  )
  .post(
    "/grants",
    async ({ body, user, actor, status }) => {
      requireCookieActor(actor, "SSH key grants are restricted to browser sessions");
      const answer = await sshCreateGrant({
        viewerId: user.id,
        aNodeId: body.node,
        name: normalizeLabel(body.name, 120),
        selector: body.selector,
        fingerprints: body.fingerprints,
      });
      if (!answer.ok) return throwCodedRefusal(answer.refusal);
      return status(201, { grant: answer.value.grant });
    },
    {
      body: t.Object({
        node: t.String({ minLength: 1, description: "Key home machine whose agent will sign (an agent node you own)" }),
        name: t.String({ minLength: 1, maxLength: 253, description: "Display name for the grant" }),
        selector: t.String({
          minLength: 1,
          maxLength: 253,
          description: "Destination selector: a concrete hostname or a '*' host pattern, stored resolved",
        }),
        fingerprints: t.Array(t.String({ minLength: 1, maxLength: 253, description: "SHA256: fingerprint" }), {
          description: "The selected public agent identities; more than SSH_MAX_GRANT_FINGERPRINTS is refused outright",
        }),
      }),
      response: {
        201: t.Object({ grant: SshGrantViewSchema }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "createSshKeyGrant",
        tags: ["ssh"],
        description:
          "Creates a standing key grant (the same row an approved first use writes). Over-cap selections are a hard error, never a truncation",
      },
    },
  )
  .patch(
    "/grants/:id",
    async ({ body, params, user, actor }) => {
      requireCookieActor(actor, "SSH key grants are restricted to browser sessions");
      const answer = await updateGrant({
        ownerUserId: user.id,
        grantId: params.id,
        name: body.name === undefined ? undefined : normalizeLabel(body.name, 120),
        selector: body.selector,
      });
      if (!answer.ok) return throwCodedRefusal(answer.refusal);
      return { grant: answer.value.grant };
    },
    {
      params: t.Object({ id: t.String({ description: "Grant row id" }) }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 253, description: "New display name" })),
        selector: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 253,
            description: "New destination selector (hostname or host pattern)",
          }),
        ),
      }),
      response: {
        200: t.Object({ grant: SshGrantViewSchema }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateSshKeyGrant",
        tags: ["ssh"],
        description:
          "Edits a grant's display name and/or destination selector. Which keys serve is immutable: change that by revoking and granting again",
      },
    },
  )
  .delete(
    "/grants/:id",
    async ({ params, user, actor, status, set }) => {
      requireCookieActor(actor, "SSH key grants are restricted to browser sessions");
      const answer = await revokeGrant({ ownerUserId: user.id, grantId: params.id });
      if (!answer.ok) {
        // Foreign AND absent, one 404 (the saved-hosts posture), rendered via
        // apiErrorBody since this arm RETURNS rather than throws; revoke's
        // only refusal arm is the 404, and the declared response agrees.
        return status(404, apiErrorBody({ code: answer.refusal.code, message: answer.refusal.message }));
      }
      // 204 with NO body at all (the 422 Response-constructor trap the
      // saved-hosts delete documents: a declared 204 schema would validate
      // an absent body and answer 400 for a successful revoke).
      set.status = 204;
    },
    {
      params: t.Object({ id: t.String({ description: "Grant row id" }) }),
      response: {
        // The comment above is the law now: revoke's ONLY refusal arm is the
        // 404, so no decorative 409 is declared.
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "revokeSshKeyGrant",
        tags: ["ssh"],
        description:
          "Revokes a grant instantly: the row goes and every live relay session running under it is cut (204 no body on success; a foreign row is the same 404 as an absent one)",
      },
    },
  );
