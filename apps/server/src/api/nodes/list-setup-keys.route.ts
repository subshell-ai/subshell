import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiModels } from "@/schema/index.js";

const SetupKeyRowSchema = t.Object({
  id: t.String({ description: "Setup key id" }),
  label: t.String({ description: "Human label given at creation" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  expiresAt: t.String({ description: "ISO 8601 expiry timestamp" }),
  usedAt: t.Nullable(t.String({ description: "ISO 8601 redemption time, null while unused" })),
  consumedNodeId: t.Nullable(t.String({ description: "Node created by redeeming this key, null while unused" })),
});

const ListResponseSchema = t.Object({
  keys: t.Array(SetupKeyRowSchema, { description: "The caller's setup keys, newest first (never the secret)" }),
});

/** Maps a stored row to the listing shape — keyHash never leaves the DB. */
function toKeyRow(row: {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  consumedNodeId: string | null;
}) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    consumedNodeId: row.consumedNodeId,
  };
}

/**
 * `GET /api/nodes/setup-keys` — the caller's own setup keys, newest first
 * (spec 2026-08-31 §9). Carries usage state (usedAt/consumedNodeId) for the
 * management UI; the key material is not in the database in recoverable form.
 * Cookie-only, mirroring the create route.
 */
export const listSetupKeyRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/setup-keys",
    async ({ user, actor }) => {
      requireCookieActor(actor, "Node setup keys are managed from the browser");
      const keys = await new NodeSetupKeysRepository(db).listByUser(user.id);
      return { keys: keys.map(toKeyRow) };
    },
    {
      response: {
        200: ListResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listNodeSetupKeys",
        tags: ["nodes"],
        description: "Lists the caller's node setup keys (never the secret)",
      },
    },
  );
