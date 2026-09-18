import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiModels } from "@/schema/index.js";

const SetupKeyRowSchema = t.Object({
  id: t.String({ description: "Setup key id" }),
  key: t.String({ description: "The setup key — usable until used or expired, inert after" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  expiresAt: t.String({ description: "ISO 8601 expiry timestamp" }),
  usedAt: t.Nullable(t.String({ description: "ISO 8601 redemption time, null while unused" })),
  consumedNodeId: t.Nullable(t.String({ description: "Node created by redeeming this key, null while unused" })),
});

const ListResponseSchema = t.Object({
  keys: t.Array(SetupKeyRowSchema, {
    description: "The caller's setup keys, newest first, each with its own key text",
  }),
});

/**
 * Maps a stored row to the listing shape.
 *
 * It is a projection, not a redaction: what it drops is `ownerUserId`, which the
 * caller already is, and it deliberately carries `key`. That is the whole point
 * of this route since the node-setup revamp (2026-09-17) — a minted key the
 * dialog closed without using was an open enrollment door the operator could
 * only close, not read, so the remedy was to revoke and re-mint. Scoping is
 * unchanged: `listByUser(user.id)` answers for the caller's own keys and nobody
 * else's, and a used or expired row's key is inert on sight.
 */
function toKeyRow(row: {
  id: string;
  key: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  consumedNodeId: string | null;
}) {
  return {
    id: row.id,
    key: row.key,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    consumedNodeId: row.consumedNodeId,
  };
}

/**
 * `GET /api/nodes/setup-keys` — the caller's own setup keys, newest first
 * (spec 2026-08-31 §9). Carries usage state (usedAt/consumedNodeId) and the key
 * text, because the Setup keys card is now the durable place a key is read
 * from. Cookie-only, mirroring the create route: a bearer credential has no
 * business enumerating enrollment doors, and this is a human reviewing what
 * they handed out.
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
        description: "Lists the caller's node setup keys, each with its key text",
      },
    },
  );
