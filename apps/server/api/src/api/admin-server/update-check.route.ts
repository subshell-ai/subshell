import { Elysia } from "elysia";
import { ServerUpdateViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { collectServerUpdateView } from "@/services/server-update.js";

/**
 * `POST /api/admin/server/update/check` — the Re-check button (spec §4.5).
 *
 * A POST that changes nothing on this host: it drops the 15-minute memo and
 * reads the release list again, then answers the same view `GET …/update`
 * does. POST rather than a query flag because it is an ACT with a cost (an
 * outbound request to the release source) rather than a rendering option, and
 * because a GET that reached the network would be cached and prefetched by
 * things that have no idea they are spending a rate limit.
 *
 * **Not audited, deliberately.** It is a read: nothing about this instance, its
 * configuration or its files changes, and an audit row per press would bury the
 * `server.update` row that matters underneath the button beside it.
 */
export const updateCheckRoute = new Elysia()
  .use(requireAdmin)
  .post("/update/check", () => collectServerUpdateView(true), {
    response: ServerUpdateViewSchema,
    detail: {
      operationId: "checkServerUpdate",
      tags: ["admin"],
      description:
        "Re-read the release source now, bypassing the 15-minute memo, and answer the same view GET /api/admin/server/update does. Changes nothing on this host and is not audited. Cookie-admin only.",
    },
  });
