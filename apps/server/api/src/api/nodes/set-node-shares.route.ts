import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { NodeSharesResponseSchema, SetNodeSharesBodySchema, toNodeShareViews } from "@/api/nodes/node-view.js";
import { apiModels } from "@/api/schemas/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { audit } from "@/modules/audit.js";
import { NodeSharesConflictError } from "@/modules/nodes/errors.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { getRelayBroker } from "@/modules/ssh/relay-broker.js";
import { ForbiddenError, HttpError } from "@/shared/errors.js";

/**
 * `PUT /api/nodes/:id/shares` `{shares:[{granteeUserId, permission}]}` —
 * replace the whole grant set (same contract as subshell-shares; null grantee
 * is the Everyone grant, unknown grantee → 400). Manager band: the node's
 * owner or a `manage` grantee, or ADMIN for `local` — where `manage` grants
 * themselves are refused (its band has no grantable half). The route accepts
 * any valid list a signed-in manager may set, Manage rows included; the
 * dialog offers Manage only on agent nodes, matching that refusal. Machine
 * actors (`nodes:share` keys) stop at View / View + edit: the rung `manage`
 * delegates day-to-day ownership, while the grant's advertised meaning is
 * launch-access control, so a leaked provisioning key must not mint itself a
 * band the ruling reserves to people (security pass on #495).
 *
 * Access is resolved from these rows on each request, and the replace CASes
 * the row set the gate authorized against: a revoke that lands while a
 * manager's PUT is in flight turns that PUT into a 409 instead of letting it
 * commit over the revocation. After replacement, close relay sessions whose
 * users no longer have launch access to both ends.
 */
export const setNodeSharesRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .put(
    "/:id/shares",
    async ({ params, body, user, actor, status }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      const entries = body.shares.map((s) => ({ granteeUserId: s.granteeUserId ?? null, permission: s.permission }));
      // A `manage` grant on the control-plane host is refused outright (spec
      // 2026-11-07). `local` has no human owner: who manages that machine has
      // always been the admins' decision, taken as a class — one share row
      // would hand the control plane itself to a single non-admin. The
      // refusal lands before any write, so a rejected PUT leaves the grant
      // set byte-identical, like every other refusal here.
      if (gate.row.kind === "local" && entries.some((e) => e.permission === "manage")) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The server's own node is managed by instance admins; a Manage share is not offered there",
          }),
        );
      }
      // Security pass on #495: `manage` delegates the day-to-day ownership
      // band, while the `nodes:share` grant advertises launch-access control.
      // A machine actor therefore stops at View / View + edit — a leaked
      // provisioning key must not mint the band for any account, and the
      // band stays what the ruling says it is: a human owner's delegation.
      if (actor !== "cookie" && entries.some((e) => e.permission === "manage")) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "A Manage grant must come from a signed-in manager; keys can share at View or View + edit",
          }),
        );
      }
      const named = entries.map((e) => e.granteeUserId).filter((x): x is string => x !== null);
      if (named.length > 0) {
        const names = await new UsersRepository(db).displayNamesByIds(named);
        const unknown = named.find((uid) => !names.has(uid));
        if (unknown) {
          return status(
            400,
            apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "Cannot share with an unknown user" }),
          );
        }
      }
      let rows: Awaited<ReturnType<NodeSharesRepository["replaceForNode"]>>;
      try {
        // The CAS compares against the rows THIS request's gate read resolved
        // its canManage from: whoever revoked a manager mid-flight wins, and
        // the stale writer is asked to refresh rather than overwrite blind.
        rows = await new NodeSharesRepository(db).replaceForNode(
          gate.row.id,
          entries,
          user.id,
          gate.shares.map((s) => s.id),
        );
      } catch (err) {
        if (err instanceof NodeSharesConflictError) throw new HttpError(409, err.message);
        throw err;
      }
      await getRelayBroker().closeUnauthorizedForNode(gate.row.id);
      await audit({
        actorUserId: user.id,
        // Spec §9 names only `node.local_share_changed` (the local-launch
        // switch is exactly this route on `local`); it lists no generic
        // shares action, so other nodes get `node.shares_set` as a documented
        // extension of the spec's audit vocabulary.
        action: gate.row.id === LOCAL_NODE_ID ? "node.local_share_changed" : "node.shares_set",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ grants: entries.length }),
      });
      return { shares: await toNodeShareViews(rows) };
    },
    {
      body: SetNodeSharesBodySchema,
      response: {
        200: NodeSharesResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "nodes:share",
      detail: {
        operationId: "setNodeShares",
        tags: ["nodes"],
        description:
          "Replace a node's sharing grants (manager band: owner, a manage grantee, or admin on local; Manage rows are human-managers only). 409 when the grant set changed underneath the caller; refresh and retry.",
      },
    },
  );
