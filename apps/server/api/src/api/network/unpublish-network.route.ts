import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
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
import { unpublishNetwork } from "@/services/network/unpublish.js";
import { originRegistry } from "@/services/trusted-origins.js";

/**
 * `POST /api/network/:id/unpublish` (spec 2026-09-15 § 5.1, § 5.3).
 *
 * Delegates the whole sequence to `services/network/unpublish.ts`, which is
 * the SAME function `PATCH /api/plugins/:id { enabled: false }` runs before it
 * flips the flag. One implementation, because the ordering inside it is a
 * safety property — process down first, guard off LAST — and two copies of an
 * ordering is one copy that will eventually be written the other way round.
 *
 * A failure is a 409 carrying the supervisor's own last lines, because the
 * thing that failed is a child process and its output is the only thing that
 * says why. It leaves the guard ON: a tunnel that would not stop is a tunnel
 * that must stay guarded.
 *
 * **The registry follows the record** (spec § 5.4, spec § 10f). The sequence
 * keeps the record's addresses — an unpublish stops serving, it does not
 * leave the network — and the registry re-derives from the record as it
 * stands: a private network keeps trusting what it is joined at, and only a
 * `public-with-gate` one stops the moment `published` goes false. Nothing is
 * written to config.env and nothing waits on a restart.
 *
 * **The wire's `origins` is the diff, not the record** (ruling R-D-lite). The
 * page's result line says what STOPPED accepting sign-ins, so the route
 * snapshots the registry's set for this plugin before the sequence and
 * reports what is gone after it: normally empty on a private network (the
 * trust follows the membership the act left untouched), the full set on a
 * gated one. The AUDIT keeps naming the recorded addresses (plan D9) — the
 * record and the audit say what the publish had held; only the answer
 * answers "what stopped".
 */
export const unpublishNetworkRoute = new Elysia().use(apiModels).post(
  "/:id/unpublish",
  async ({ params, request, status }) => {
    await requireNetworkAdmin(request);
    const prepared = await prepareNetworkAct(params.id);
    if ("status" in prepared) {
      return status(prepared.status, apiErrorBody({ code: prepared.code, message: prepared.message }));
    }
    const { resolved, ctx, release } = prepared;
    const id = resolved.entry.manifest.id;
    try {
      // The diff of two reads of ONE in-memory registry, taken around the
      // sequence whose fifth step re-derives it — nothing to race.
      const before = [...originRegistry().pluginOrigins(id)];
      const result = await unpublishNetwork(id);
      invalidateNetworkStatus(id);
      if (!result.ok) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.EXISTS_ERROR,
            // The last lines ride in the MESSAGE rather than a side channel:
            // `apiErrorBody` carries one sentence to the page, and a failed
            // stop with no output shown is a dialog that says "it did not
            // work" and nothing else.
            message: [result.message, ...result.lastLines].join("\n"),
          }),
        );
      }
      await auditNetwork(request, "network.unpublish", id, { origins: result.origins });
      return {
        ok: true as const,
        // What the sequence took OUT of the trust set. The service's
        // `result.origins` stays the recorded list (its own tests pin it);
        // the wire wants this answer instead.
        origins: before.filter((o) => !originRegistry().pluginOrigins(id).includes(o)),
        status: await readNetworkStatus(resolved.entry, ctx, { fresh: true }),
      };
    } finally {
      release();
    }
  },
  {
    params: NetworkParamsSchema,
    response: {
      200: NetworkActionResponseSchema,
      // 400 is unreachable from this handler today, but `NetworkRefusal`'s
      // status is the shared `400 | 404 | 409` — naming it keeps the map
      // honest about what `prepareNetworkAct` may hand back.
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      404: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "unpublishNetwork",
      tags: ["network"],
      description:
        "Stops publishing this server on the network (admin cookie only): the supervised process is stopped and awaited, the plugin unpublishes, the request guard is dropped, and the record is rewritten — the trusted-origin registry follows the record, so nothing is written to config.env and no restart is needed. The response names the origins that stopped being trusted (normally empty for a private network, whose trust follows membership) and carries the fresh status; the audit row names the recorded addresses. 409 with the child's last lines when the process would not stop. Audited as network.unpublish.",
    },
  },
);
