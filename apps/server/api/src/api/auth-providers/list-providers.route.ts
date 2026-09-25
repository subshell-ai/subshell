import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { ProviderViewSchema, toView } from "@/api/auth-providers/provider-view.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";

/** GET /api/auth-providers response. */
const ListResponseSchema = t.Object({
  providers: t.Array(ProviderViewSchema, {
    description: "Every provider row, stored order (position, then id) — the email row first",
  }),
});

/**
 * `GET /api/auth-providers` — every provider row for the admin table (cookie-admin
 * only). The client secret is never serialized; hasSecret says whether one is
 * stored.
 */
export const listProvidersRoute = new Elysia()
  .use(requireAdmin)
  .get("/", async () => ({ providers: (await new AuthProvidersRepository(db).listAll()).map(toView) }), {
    response: ListResponseSchema,
    detail: {
      operationId: "listAuthProviders",
      tags: ["auth-providers"],
      description:
        "Every auth provider row for the admin table (cookie-admin only). The client secret is never serialized; hasSecret says whether one is stored",
    },
  });
