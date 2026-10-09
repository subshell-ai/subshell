import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import {
  machinePinRepairRefusal,
  repairMachinePin,
  SshMachinePinRepairError,
} from "@/services/ssh-machine-pins.service.js";

const RepairedSchema = t.Object({
  repaired: t.Boolean({ description: "Always true on success: the machine's ack confirmed the write" }),
});

/** Repair one peer pin: cookie owner on an enrolled node, cookie admin on the server host. */
export const repairNodeMachinePinRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/machine-pins/:peerNodeId/repair",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Machine trust re-pairing is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) {
        throw new ForbiddenError();
      }
      try {
        await repairMachinePin({ actorUserId: user.id, nodeId: gate.row.id, peerNodeId: params.peerNodeId });
      } catch (err) {
        if (err instanceof SshMachinePinRepairError) {
          const refusal = machinePinRepairRefusal(err);
          return status(refusal.status, apiErrorBody({ code: refusal.code, message: refusal.message }));
        }
        throw err;
      }
      return { repaired: true };
    },
    {
      params: t.Object({
        id: t.String({ description: "Node id (the machine whose pin store is repaired)" }),
        peerNodeId: t.String({ description: "Peer node id (the stored pin being replaced)" }),
      }),
      response: {
        200: RepairedSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "repairNodeMachinePin",
        tags: ["nodes"],
        description:
          "Re-pair one peer's machine trust pin on a machine you own: the plane re-delivers the peer's registered public keys to it, replacing that peer's stored pin (spec 2026-10-08 §4.5). The machine must be online; the act is audited naming the peer id only.",
      },
    },
  );
