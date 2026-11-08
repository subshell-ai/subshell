import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { authGuard } from "@/api/auth-guard.js";
import { apiModels } from "@/api/schemas/index.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { nodeCanTransfer } from "@/modules/nodes/access.js";
import { isUniqueNameViolation } from "@/modules/nodes/errors.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { transferNodeOwnership } from "@/modules/nodes/transfer-ownership.js";
import { accountDisabled, accountPending } from "@/modules/users/account-status.js";
import { ForbiddenError, HttpError } from "@/shared/errors.js";

const TransferBodySchema = t.Object({
  toUserId: t.String({ minLength: 1, maxLength: 64, description: "The account taking ownership of the node" }),
  retainAccessAsManager: t.Boolean({
    description:
      "Keep the outgoing owner as a manage grantee on their own former node. Required at the wire; there is no silent default in either direction",
  }),
});

const TransferResponseSchema = t.Object({
  nodeId: t.String({ description: "The node that moved" }),
  ownerUserId: t.String({ description: "The account that owns it now" }),
  retainedAccessAsManager: t.Boolean({ description: "Whether the outgoing owner was kept on as a manage grantee" }),
});

/**
 * `POST /api/nodes/:id/transfer` — the ownership handover (spec 2026-11-07).
 *
 * **Three doors, one policy: only the node's owner can hand it over, and only
 * machine credentials explicitly granted `nodes:transfer` can act at all.**
 * A manage grantee runs everything ELSE the owner can do and stops exactly
 * here; the retire gate's admin arm does not reach this either (an admin
 * deleting a foreign node is fleet care; an admin taking one over is a
 * seizure). Cookies therefore need `access === "owner"` literally, and
 * machine actors arrive through the display-readiness posture — authGuard +
 * `loadNodeGate`, whose bearer arm is owner-equality — because
 * `nodeManagementGuard` refuses subshell tokens outright and a pane derived
 * from a granted automation key is supposed to reach its parent's doors.
 *
 * The `systemPermission` annotation filters versioned keys and derived pane
 * credentials by grant; it lets the UNVERSIONED map (legacy system keys, and
 * panes minted from plain human logins) through as it always has, so the
 * handler re-asks below — legacy keys and plain panes never open this door.
 *
 * Refusal order is the shares group's: 404 for absent AND invisible (a
 * foreign node is no one's business to locate), then `local` answered by the
 * ROUTE before the caller is asked (this surface never applies to the
 * control-plane host, owner or not).
 */
export const transferNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/transfer",
    async ({ params, body, user, actor, systemKeyPermissions, status }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The server's own node belongs to the instance, not to a person; it has no owner to hand it over",
          }),
        );
      }
      // The machine door. `systemKeyPermissions` is null for a legacy key and
      // for a pane token minted from an ordinary human session, and the guard
      // macro passes both through — so the handler refuses anything that is
      // not an explicit grant on the credential itself.
      if (actor !== "cookie" && !(systemKeyPermissions?.includes("nodes:transfer") ?? false)) {
        throw new HttpError(403, "This credential needs the nodes:transfer permission to hand over a node");
      }
      // The human door, on the SAME helper the rendered `canTransfer` flag
      // uses: manage (even the boosted band) and admin both stop at 403.
      if (!nodeCanTransfer(gate.access, gate.row.kind)) throw new ForbiddenError();

      if (body.toUserId === gate.row.ownerUserId) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "That node already belongs to this account",
          }),
        );
      }
      const names = await new UsersRepository(db).displayNamesByIds([body.toUserId]);
      if (!names.has(body.toUserId)) {
        return status(
          400,
          apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "There is no account with that id" }),
        );
      }
      // Handing a node to a disabled account would mint a machine no one can
      // operate until the ban lifts — and disablement already revoked that
      // account's credentials, so the "success" would be furniture.
      if (await accountDisabled(db, body.toUserId)) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "That account is disabled; re-enable it before transferring a node to it",
          }),
        );
      }
      // Approval-pending is the same stranded machine (security pass on #495):
      // the account cannot sign in until an admin admits it, so the handover
      // would land on a door no one holds a key to yet.
      if (await accountPending(db, body.toUserId)) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "That account is still awaiting approval; approve it before transferring a node to it",
          }),
        );
      }

      try {
        await transferNodeOwnership({
          nodeId: gate.row.id,
          fromUserId: gate.row.ownerUserId,
          toUserId: body.toUserId,
          retainAccessAsManager: body.retainAccessAsManager,
          apiKeyId: gate.row.apiKeyId,
        });
      } catch (err) {
        if (isUniqueNameViolation(err)) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.NODE_NAME_TAKEN,
              message: `That account already has a node named "${gate.row.name}". Rename one of them first.`,
              metadataSafe: { name: gate.row.name },
            }),
          );
        }
        throw err;
      }
      return {
        nodeId: gate.row.id,
        ownerUserId: body.toUserId,
        retainedAccessAsManager: body.retainAccessAsManager,
      };
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: TransferBodySchema,
      response: {
        200: TransferResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "nodes:transfer",
      detail: {
        // No hand-written `security`: this route genuinely serves bearer
        // actors through the grant, and declaring cookie-only here would
        // document the machine door out of the OpenAPI page (the
        // systemPermission macro's own security list is the truth).
        operationId: "transferNode",
        tags: ["nodes"],
        description:
          "Hand a node to another account (owner only, never the server's own node; automation needs a credential carrying the nodes:transfer grant; the machine's link, running subshells, and other shares are unaffected)",
      },
    },
  );
