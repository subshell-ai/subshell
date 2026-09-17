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
import { forgetNetworkOrigins } from "@/services/network/origins.js";
import { clearNetworkState } from "@/services/network/state.js";
import { unpublishNetwork } from "@/services/network/unpublish.js";
import { originRegistry } from "@/services/trusted-origins.js";

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
 * **The record is gone, and so is the trust** (spec § 10f): leave ran the
 * § 5.3 sequence, cleared the record, and the registry forgets this plugin
 * outright. **The wire's `origins` is what the WHOLE act untrusted** (ruling
 * R-D-lite v2): leave is a compound act, "as of this answer" means
 * before-click versus after-click, so the route snapshots the registry's set
 * for this plugin at REQUEST START and that snapshot is the answer. A gated
 * tunnel's trust dies at the inner unpublish step but the ACT ends it — a
 * pre-forget snapshot would answer empty for exactly the published tunnel
 * the operator just left. The audit keeps `{ origins: unpublished.origins }`
 * — the recorded list, as on unpublish.
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

      // Snapshotted at request start because the answer is the ACT's
      // transition: a gated network's trust dies at the inner unpublish step,
      // but it is this act that ends it (ruling R-D-lite v2).
      const trusted = [...originRegistry().pluginOrigins(id)];

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
      // The record is gone and so is the trust; the fresh re-read below only
      // re-learns an address if the machine is, in fact, still on the network.
      forgetNetworkOrigins(id);
      invalidateNetworkStatus(id);
      await auditNetwork(request, "network.leave", id, { origins: unpublished.origins });
      return {
        ok: true as const,
        origins: trusted,
        status: await readNetworkStatus(resolved.entry, ctx, { fresh: true }),
      };
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
        "Takes this machine off the network (admin cookie only): unpublish, then the plugin's own leave, then the host forgets this plugin's recorded state and the trusted-origin registry forgets the plugin. `confirm` must equal the plugin id. The plugin's stored secrets are NOT deleted — that is an uninstall, not a leave. The response names the origins whose trust this act ended (snapshot taken at request start, so a gated published tunnel IS named) and carries the fresh status; the audit row names the recorded addresses. Audited as network.leave with the origins.",
    },
  },
);
