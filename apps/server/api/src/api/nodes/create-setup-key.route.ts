import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { isCookieAdmin } from "@/api/user-utils.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { ALLOW_NODE_ENROLLMENT_KEY } from "@/services/registration-gate.js";

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
 *
 * **This is the only chokepoint on adding a machine to the instance**, which
 * is why the `allow_node_enrollment` setting is enforced HERE and nowhere
 * else. Enrolling is unauthenticated by design — the key IS the credential —
 * so there is nothing to gate at `POST /api/nodes/enroll`, and gating it
 * would refuse keys the instance itself handed out.
 *
 * Off ⇒ non-admins get 403; admins are unaffected, the same shape as an admin
 * creating a user through `POST /api/users` while sign-up is closed. And it
 * does NOT invalidate keys already minted (operator's call): flipping it is
 * "stop handing these out", not "revoke what is outstanding". Anything still
 * unconsumed expires in 24 h, and the Nodes page lists and deletes them —
 * which is the act that revokes, and is audited as such.
 */
export const createSetupKeyRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/setup-keys",
    async ({ body, user, actor, set, status }) => {
      requireCookieActor(actor, "Node setup keys are managed from the browser");
      // Absent row = allowed, so an instance that never set this is unchanged.
      const allowed = await new SettingsRepository(db).get(ALLOW_NODE_ENROLLMENT_KEY, true);
      if (!allowed && !(await isCookieAdmin(user, actor))) {
        return status(
          403,
          apiErrorBody({
            code: BackendErrorCodes.ACCESS_DENIED,
            message: "An admin has turned off adding nodes on this instance; ask one to add this machine.",
          }),
        );
      }
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
