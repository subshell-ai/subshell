import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import {
  auditNetwork,
  invalidateNetworkStatus,
  prepareNetworkAct,
  readNetworkStatus,
  requireNetworkAdmin,
} from "@/api/network/network-gate.js";
import { NetworkActionResponseSchema, NetworkParamsSchema } from "@/api/network/schemas.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { clearNetworkState } from "@/services/network/state.js";
import { unpublishNetwork } from "@/services/network/unpublish.js";

const LeaveBodySchema = t.Object(
  {
    confirm: t.String({
      description: "The plugin id, typed back. Anything else is refused — leaving discards this machine's membership",
    }),
  },
  { description: "Typed confirmation, because leaving cannot be undone from here" },
);

/**
 * `POST /api/network/:id/leave` (spec 2026-09-15 § 5.1).
 *
 * Takes this machine off the network entirely: unpublish first (the § 5.3
 * sequence, so a tunnel is never left alive pointing at a host that has left),
 * then the plugin's own `leave`, then the host forgets what it recorded.
 *
 * **A typed confirmation, matching the plugin id.** Leaving discards a
 * membership that a pre-authentication key, an interactive sign-in or a
 * one-time invite paid for, and nothing on this server can restore it — so the
 * act asks for more than a click. A mismatch is a 400 before anything runs.
 *
 * **`clearNetworkState` forgets the settings, never the secrets.** The secret
 * store beside it is the installer's business: conflating "this machine is off
 * the network" with "destroy this plugin's credentials" would make leaving and
 * uninstalling the same act, and an admin who leaves in order to rejoin under
 * a different hostname would have to paste the key again.
 */
export const leaveNetworkRoute = new Elysia().use(apiModels).post(
  "/:id/leave",
  async ({ params, body, request, status }) => {
    await requireNetworkAdmin(request);
    const prepared = await prepareNetworkAct(params.id);
    if ("status" in prepared) {
      return status(prepared.status, apiErrorBody({ code: prepared.code, message: prepared.message }));
    }
    const { resolved, ctx, release } = prepared;
    const id = resolved.entry.manifest.id;
    try {
      // Checked AFTER the plugin resolves, so a typo in the id answers 404
      // ("no such network") rather than 400 ("that is not the confirmation"),
      // which would be a confusing thing to read about an id that does not
      // exist.
      if (body.confirm !== id) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: `Type "${id}" to confirm leaving ${resolved.entry.manifest.name}.`,
          }),
        );
      }

      // Unpublish FIRST and refuse on failure: leaving a network while a
      // tunnel still points at this host would leave that tunnel serving
      // requests for an address the machine no longer answers on.
      const unpublished = await unpublishNetwork(id);
      invalidateNetworkStatus(id);
      if (!unpublished.ok) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.EXISTS_ERROR,
            message: [unpublished.message, ...unpublished.lastLines].join("\n"),
          }),
        );
      }

      await resolved.entry.plugin.leave(ctx);
      await clearNetworkState(id);
      invalidateNetworkStatus(id);
      await auditNetwork(request, "network.leave", id, {});
      return { ok: true as const, status: await readNetworkStatus(resolved.entry, ctx, { fresh: true }) };
    } finally {
      release();
    }
  },
  {
    params: NetworkParamsSchema,
    body: LeaveBodySchema,
    response: {
      200: NetworkActionResponseSchema,
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      404: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "leaveNetwork",
      tags: ["network"],
      description:
        "Takes this machine off the network (admin cookie only): unpublish, then the plugin's own leave, then the host forgets this plugin's recorded state. `confirm` must equal the plugin id. The plugin's stored secrets are NOT deleted — that is an uninstall, not a leave. Audited as network.leave.",
    },
  },
);
