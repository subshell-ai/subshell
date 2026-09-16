import { Elysia } from "elysia";
import { requireNetworkAdmin } from "@/api/network/network-gate.js";
import { listNetworkRows } from "@/api/network/network-view.js";
import { NetworkListResponseSchema } from "@/api/network/schemas.js";
import { apiModels } from "@/schema/index.js";

/**
 * `GET /api/network` (spec 2026-09-15 § 5.1).
 *
 * What this MACHINE's network state is, as against `/api/plugins`, which is
 * what the instance has installed. The difference is why this is a separate
 * module and not a field on the plugin row: answering it runs a live vendor
 * CLI probe per enabled, supported plugin, so it is cookie-admin only and
 * memoised for three seconds rather than open to every signed-in actor.
 *
 * Every row is rendered from manifest DATA — platforms, exposure, the install
 * command, the privileged steps — so a row for a plugin this OS cannot drive,
 * or whose vendor CLI is not installed, still says what it is and what to do
 * next. `status` is present only where a probe actually ran.
 */
export const listNetworksRoute = new Elysia().use(apiModels).get(
  "/",
  async ({ request }) => {
    await requireNetworkAdmin(request);
    return { networks: await listNetworkRows() };
  },
  {
    response: {
      200: NetworkListResponseSchema,
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
    },
    detail: {
      operationId: "listNetworks",
      tags: ["network"],
      description:
        "Every installed network plugin with this host's live state: platform support, stored settings (secrets as presence only), the supervised process, and a live status() probe for each enabled and supported one (memoised 3s). Admin cookie only; bearer keys are refused.",
    },
  },
);
