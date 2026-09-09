import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

const CreateBodySchema = t.Object({
  label: t.String({ minLength: 1, maxLength: 64, description: "Human label for the key (e.g. 'mac mini')" }),
});

const CreateResponseSchema = t.Object({
  id: t.String({ description: "Setup key id (for later revocation)" }),
  key: t.String({ description: "The plaintext setup key; shown exactly once, store it now" }),
  expiresAt: t.String({ description: "ISO 8601 expiry (24 h from creation)" }),
});

/**
 * `POST /api/nodes/setup-keys` — mints a single-use node enrollment key
 * (spec 2026-08-31 §5.1/§9). Only the SHA-256 hash is stored; the plaintext
 * is returned exactly once here. Cookie-only: managing enrollment credentials
 * is a human act, so machine actors are refused with 403.
 */
export const createSetupKeyRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/setup-keys",
    async ({ body, user, actor, set }) => {
      requireCookieActor(actor, "Node setup keys are managed from the browser");
      const { row, plaintext } = await new NodeSetupKeysRepository(db).create(body.label, user.id);
      await audit({
        actorUserId: user.id,
        action: "setup_key.create",
        targetType: "node-setup-key",
        targetId: row.id,
        metadataJson: JSON.stringify({ label: body.label }),
      });
      set.status = 201;
      return { id: row.id, key: plaintext, expiresAt: row.expiresAt };
    },
    {
      body: CreateBodySchema,
      response: {
        201: CreateResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "createNodeSetupKey",
        tags: ["nodes"],
        description: "Mints a single-use node setup key; the plaintext is returned only here",
      },
    },
  );
