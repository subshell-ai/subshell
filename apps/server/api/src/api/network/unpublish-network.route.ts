import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import {
  auditNetwork,
  invalidateNetworkStatus,
  prepareNetworkAct,
  readNetworkStatus,
  requireNetworkAdmin,
} from "@/api/network/network-gate.js";
import { NetworkParamsSchema, NetworkRemovalResponseSchema } from "@/api/network/schemas.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { unpublishNetwork } from "@/services/network/unpublish.js";

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
 * **The origins the publish added leave with it** (spec § 5.4, amended
 * 2026-09-16). The subtraction runs through the same only-writer as the
 * publish's union, inside the sequence, and the response carries what became
 * of it: `config` for the write, `restartRequired` only when a write
 * actually landed, and `origins` for the page to name what it removed. A key
 * the environment owns is refused by name while the unpublish itself stands.
 * The `publishImplicit` kind subtracts too (spec § 5.3, REVERSED 2026-09-16 —
 * the first cut left its record and origins whole): after a disable the daemon
 * may still ANSWER at its NetBird address, and what stripping changes is that
 * the address stops ACCEPTING sign-ins when the restart lands. That is the
 * stated, chosen cost of letting a publish own an origin's lifecycle — and
 * `leave`, the verb that actually leaves the network, ends the addresses
 * themselves anyway.
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
        status: await readNetworkStatus(resolved.entry, ctx, { fresh: true }),
        config: result.config,
        // Genuinely computed, never a literal: a removal awaits a restart only
        // when it landed in the file. `changed` is non-empty only after a
        // successful write, so the environment-owned refusal and the
        // nothing-matched silence both leave the page with no restart to offer.
        restartRequired: (result.config?.changed.length ?? 0) > 0,
        origins: result.origins,
      };
    } finally {
      release();
    }
  },
  {
    params: NetworkParamsSchema,
    response: {
      200: NetworkRemovalResponseSchema,
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
        "Stops publishing this server on the network (admin cookie only): the supervised process is stopped and awaited, the plugin unpublishes, the request guard is dropped, and the origins this network's publish added are subtracted from TRUSTED_ORIGINS through the CLI's own config writer — the write's outcome rides the response (config, restartRequired, origins). A key the environment owns is refused by name while the unpublish itself stands. The subtraction applies to every network kind, publishImplicit included (spec § 5.3 reversed 2026-09-16): a daemon that still answers on membership alone stops accepting sign-ins at the restart. 409 with the child's last lines when the process would not stop. Audited as network.unpublish.",
    },
  },
);
