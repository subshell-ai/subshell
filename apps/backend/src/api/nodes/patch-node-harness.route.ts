import { BackendErrorCodes } from "@internal/backend-errors";
import { getHarness } from "@internal/harnesses";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { HarnessStateError, toggleLocalHarness } from "@/api/harness-utils.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { ensureDefaultProfilesForHarness } from "@/services/default-profiles.js";
import { readAgentInventory } from "@/services/nodes/inventory.js";
import { logger } from "@/utils/logger.js";

/** Same body shape as `PATCH /api/setup/harnesses/:id` (kept separate for schema drift headroom). */
const EnableBodySchema = t.Object({
  enabled: t.Boolean({ description: "Whether the harness should be available on this node" }),
});

/**
 * `PATCH /api/nodes/:id/harnesses/:harnessId` `{enabled}` — per-node harness
 * toggle (spec 2026-08-31 §6.2/§9), gate `nodeCanConfigure` (owner, `edit`
 * grantee, or admin — on `local` the seeded Everyone/edit row keeps every
 * cookie user able to toggle, matching today's setup-card behavior).
 * Cookie-only, mirroring the rest of the registry this phase.
 *
 * Two stores, by node kind — the same split the spec draws:
 * - **local**: a thin alias over the setup route's path — both call
 *   `toggleLocalHarness`, so `harness_plugins` remains the single
 *   authoritative store for the control-plane host and the two routes can
 *   never disagree. No `node_harnesses` row is ever written for `local`.
 * - **agent**: a lazy `node_harnesses` row (absent row → plugin default).
 *   Enable is inventory-gated: 409 only when a FRESH (≤ TTL) snapshot
 *   EXPLICITLY reports the harness not installed. A stale snapshot does not
 *   block (stale ≠ absent — it may have been installed since), and so does a
 *   never-reported one (the inventory may simply not have run yet; phase-1
 *   agents do not exist yet — deliberate leniency, tested as such). Disable
 *   never consults the inventory, mirroring the setup route.
 *
 * Enabling (either kind, after the gate) seeds Default profiles best-effort,
 * exactly like the setup route's call site.
 */
export const patchNodeHarnessRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id/harnesses/:harnessId",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Harness toggles are restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();
      const harness = getHarness(params.harnessId);
      if (!harness) throw new HarnessStateError("Unknown harness", 404);

      if (gate.row.kind === "local") {
        await toggleLocalHarness(harness.id, body.enabled);
      } else {
        if (body.enabled) {
          const inv = readAgentInventory(gate.row);
          if (inv.fresh && inv.entries.get(harness.id)?.installed === false) {
            throw new HarnessStateError(`"${harness.name}" is not installed on "${gate.row.name}"`, 409);
          }
        }
        await new NodeHarnessesRepository(db).setEnabled(gate.row.id, harness.id, body.enabled);
        if (body.enabled) {
          // Mirror of the setup route's enable seam (best-effort — the toggle
          // already committed; the boot sweep heals a failed seed).
          await ensureDefaultProfilesForHarness(db, harness.id).catch((err: unknown) => {
            logger
              .withError(err)
              .warn(`default-profile seeding failed on enabling harness ${harness.id} on node ${gate.row.id}`);
          });
        }
      }
      return await toNodeView(gate.row, gate.access);
    },
    {
      params: t.Object({
        id: t.String({ description: "Node id ('local' toggles the instance-wide store)" }),
        harnessId: t.String({ description: "Harness plugin id" }),
      }),
      body: EnableBodySchema,
      response: {
        200: NodeViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "setNodeHarnessEnabled",
        tags: ["nodes"],
        description:
          "Enable/disable a harness on one node (local: setup-route semantics; agent: inventory-gated enable, 409 on a fresh not-installed report)",
      },
    },
  );
