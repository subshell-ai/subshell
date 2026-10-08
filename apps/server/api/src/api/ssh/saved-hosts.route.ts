import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import {
  SshDestinationField,
  SshResolveRefusalViewSchema,
  SshSavedHostViewSchema,
  throwCodedRefusal,
} from "@/api/ssh/ssh-views.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import {
  sshRemoveSavedHost,
  sshSavedHostsView,
  sshSaveHost,
  sshSetDefaultNode,
} from "@/services/ssh-launch.service.js";

/**
 * The launcher screen's own data (spec 2026-10-07 §7): the owner's saved and
 * recently-connected destinations plus the default connecting machine.
 *
 * The rows are per-owner like prompts: a foreign row is invisible and its id
 * answers the same 404 an absent one does (the ownership axis, docs/
 * security.md §3), and CRUD here audits NOTHING — a preference row is not an
 * event, the prompts precedent (the ACT the ledger records is `ssh.launch`,
 * audited by the service).
 *
 * `PUT` resolves the destination first (the ledger is keyed by the CANONICAL
 * resolved destination, so an edited alias can never silently re-point a
 * saved row), which means the write carries the launch's gate: a machine the
 * caller may not SSH through cannot hold their saved entry, and a
 * refusal-shaped outcome is the same 422 `{outcome}` a launch answers.
 */
export const sshSavedHostsRoutes = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/saved-hosts",
    async ({ user, actor }) => {
      requireCookieActor(actor, "SSH saved hosts are restricted to browser sessions");
      return await sshSavedHostsView(user.id);
    },
    {
      response: {
        200: t.Object({
          saved: t.Array(SshSavedHostViewSchema, { description: "Rows a human saved, newest save first (max 20)" }),
          recent: t.Array(SshSavedHostViewSchema, {
            description: "Most-recently-connected destinations, saved or not, newest first (max 20)",
          }),
          defaultNodeId: t.Nullable(
            t.String({ description: "Stored default connecting machine id; resolves to null when none was chosen" }),
            {
              description:
                "The caller's default connecting machine, or null. A node deleted since reads back as the stored id; the client decides",
            },
          ),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSshSavedHosts",
        tags: ["ssh"],
        description: "Lists the caller's saved and recently-used SSH destinations and their default connecting machine",
      },
    },
  )
  .put(
    "/saved-hosts",
    async ({ body, user, actor, status }) => {
      requireCookieActor(actor, "SSH saved hosts are restricted to browser sessions");
      const answer = await sshSaveHost({
        viewerId: user.id,
        nodeId: body.node,
        destination: body.destination,
        alias: body.alias,
      });
      if (!answer.ok) {
        // A refusal-shaped outcome refuses the SAVE with the same 422 body a
        // launch answers (the saved key comes from the resolution; there is
        // nothing to store without it). Everything else is a coded refusal.
        const r = answer.refusal;
        if (r.status !== 422) return throwCodedRefusal(r);
        return status(422, { outcome: r.outcome });
      }
      return answer.value;
    },
    {
      body: t.Object({
        node: t.String({ minLength: 1, description: "Machine to resolve the destination on (the gate owner)" }),
        destination: SshDestinationField,
        alias: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 253,
            description: "Display label override; absent keeps the resolved snapshot's own alias",
          }),
        ),
      }),
      response: {
        200: SshSavedHostViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        422: t.Object({ outcome: SshResolveRefusalViewSchema }),
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "saveSshHost",
        tags: ["ssh"],
        description:
          "Saves one destination for the caller (resolves it first; the key is the canonical host:port, never the alias). Refusal-shaped outcomes answer 422 carrying the outcome and store nothing",
      },
    },
  )
  .delete(
    "/saved-hosts/:id",
    async ({ params, user, actor, status, set }) => {
      requireCookieActor(actor, "SSH saved hosts are restricted to browser sessions");
      const removed = await sshRemoveSavedHost(user.id, params.id);
      if (!removed) {
        // Foreign AND absent, one 404: the id is not an existence oracle.
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Saved host not found" }));
      }
      // 204 with NO body at all, set on `set` and returned undefined: a
      // `status(204, null)` body trips the fetch Response constructor (204
      // may not carry one) and Elysia would serialize the null anyway.
      set.status = 204;
    },
    {
      params: t.Object({ id: t.String({ description: "Saved-host row id" }) }),
      response: {
        // 204 is deliberately NOT declared: a declared schema makes Elysia
        // validate the (absent) body and answer 400 for a successful delete.
        // The handler sets `set.status = 204` and returns nothing; OpenAPI
        // reads the empty success from the detail description below.
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "deleteSshSavedHost",
        tags: ["ssh"],
        description:
          "Deletes one of the caller's saved destinations (204 no body on success; a foreign row is the same 404 as an absent one)",
      },
    },
  )
  .patch(
    "/preferences",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, "SSH preferences are restricted to browser sessions");
      const answer = await sshSetDefaultNode(user.id, body.defaultNodeId);
      if (!answer.ok) return throwCodedRefusal(answer.refusal); // the one arm it can carry is the write-time 404
      return { defaultNodeId: answer.value };
    },
    {
      body: t.Object({
        defaultNodeId: t.Nullable(
          t.String({ minLength: 1, description: "Node id to default the launcher's machine picker to" }),
          { description: "null clears the default" },
        ),
      }),
      response: {
        200: t.Object({
          defaultNodeId: t.Nullable(t.String({ description: "The stored default machine id (null = none)" })),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setSshPreferences",
        tags: ["ssh"],
        description:
          "Sets (or clears) the caller's default connecting machine; the write validates the node is one the caller can see, a later deletion leaves the stored id readable",
      },
    },
  );
