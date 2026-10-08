import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { SshGrantRequestViewSchema, SshGrantViewSchema, throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { apiModels } from "@/schema/index.js";
import {
  approveGrant,
  denyGrant,
  listGrantRequests,
  listRequestAgentIdentities,
} from "@/services/ssh-grants.service.js";

/**
 * `/api/ssh/grant-requests` - the first-use approval queue (spec 2026-10-08
 * §6.2, modeled on the signup pending-approvals queue): GET the owner's
 * pending questions, GET `/:id/identities` (the key home's public agent
 * roster to choose FROM, §5.4), POST `/:id/approve` (selects the fingerprints
 * and writes the standing grant), POST `/:id/deny` (an answer, no grant).
 *
 * The actor model is decision 5 stated concretely: rows are owned by the key
 * home's owner, the asking launch could only have gated A through
 * `nodeCanSsh` (SSH is owner-reserved on agent machines), and these routes
 * are cookie-scoped to the row's owner - so the answering human IS the key
 * home's owner, always, and a foreign id is the same 404 an absent row is.
 * The selection cap and grammar live in the service; a second answer to an
 * answered row is the named 409, because the row records the whole lifecycle
 * rather than being rewritten by it.
 *
 * GET sweeps lazily first: a queue read never shows a question the deadline
 * has already closed as still open.
 */
export const sshGrantRequestsRoutes = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/grant-requests",
    async ({ user, actor }) => {
      requireCookieActor(actor, "SSH grant approvals are restricted to browser sessions");
      return { requests: await listGrantRequests({ ownerUserId: user.id }) };
    },
    {
      response: {
        200: t.Object({
          requests: t.Array(SshGrantRequestViewSchema, { description: "The caller's pending approvals, newest first" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSshGrantRequests",
        tags: ["ssh"],
        description:
          "Lists the caller's outstanding first-use key-grant approvals, each naming the asking pane, the connecting machine, and the resolved destination",
      },
    },
  )
  .get(
    "/grant-requests/:id/identities",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, "SSH grant approvals are restricted to browser sessions");
      const answer = await listRequestAgentIdentities({ ownerUserId: user.id, requestId: params.id });
      if (!answer.ok) return throwCodedRefusal(answer.refusal);
      return { identities: answer.value.identities };
    },
    {
      params: t.Object({ id: t.String({ description: "Request row id" }) }),
      response: {
        200: t.Object({
          identities: t.Array(
            t.Object({
              fingerprint: t.String({
                description:
                  "Public agent identity in the canonical SHA256: notation (the approval body sends these back verbatim)",
              }),
              comment: t.String({ description: "OpenSSH's label for the key, as the agent reports it (display only)" }),
            }),
            {
              description:
                "The key home's WHOLE public roster with the key blobs withheld; the operator selects the grant's subset (cap enforced at approval, never by truncating this list)",
            },
          ),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSshGrantRequestAgentIdentities",
        tags: ["ssh"],
        description:
          "Enumerates the key home's live agent identities for the approval screen (fingerprints plus comments, blobs withheld); an offline or refusing key home answers a named error and the request stays pending, never a fabricated empty roster",
      },
    },
  )
  .post(
    "/grant-requests/:id/approve",
    async ({ body, params, user, actor }) => {
      requireCookieActor(actor, "SSH grant approvals are restricted to browser sessions");
      const answer = await approveGrant({
        ownerUserId: user.id,
        requestId: params.id,
        fingerprints: body.fingerprints,
        name: body.name === undefined ? undefined : normalizeLabel(body.name, 120),
      });
      if (!answer.ok) return throwCodedRefusal(answer.refusal);
      return { grant: answer.value.grant };
    },
    {
      params: t.Object({ id: t.String({ description: "Request row id" }) }),
      body: t.Object({
        fingerprints: t.Array(t.String({ minLength: 1, maxLength: 253, description: "SHA256: fingerprint" }), {
          description:
            "The public agent identities this grant may sign with (from the roster fetch); more than SSH_MAX_GRANT_FINGERPRINTS is a hard error, never a truncation",
        }),
        name: t.Optional(t.String({ minLength: 1, maxLength: 253, description: "Display name for the new grant" })),
      }),
      response: {
        200: t.Object({ grant: SshGrantViewSchema }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "approveSshGrantRequest",
        tags: ["ssh"],
        description:
          "Answers a pending first-use approval YES: writes the standing grant with exactly the selected identities and audits the answer naming the chosen fingerprints (public SHA256: identifiers) and the destination, per the durable selection record in docs/security.md §10",
      },
    },
  )
  .post(
    "/grant-requests/:id/deny",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, "SSH grant approvals are restricted to browser sessions");
      const answer = await denyGrant({ ownerUserId: user.id, requestId: params.id });
      if (!answer.ok) return throwCodedRefusal(answer.refusal);
      return { requestId: answer.value.requestId };
    },
    {
      params: t.Object({ id: t.String({ description: "Request row id" }) }),
      body: t.Object({}),
      response: {
        200: t.Object({
          requestId: t.String({ description: "The request that was answered (now standing denied)" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "denySshGrantRequest",
        tags: ["ssh"],
        description:
          "Answers a pending first-use approval NO: the audit row is the only writing, no grant and no pin exists for a denial, and a later relaunch simply asks again",
      },
    },
  );
