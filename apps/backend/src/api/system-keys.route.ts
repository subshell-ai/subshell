import { Elysia, t } from "elysia";
import { HttpError, requireAdmin } from "@/api/auth-guard.js";
import type { ApiKeyListRow, CreatedApiKey } from "@/auth/apikey-store.js";
import { deleteApiKey, isSystemKey, listSystemKeys, setApiKeyEnabled } from "@/auth/apikey-store.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { audit } from "@/services/audit.js";

const KeyRowSchema = t.Object({
  id: t.String({ description: "API key id" }),
  name: t.String({ description: "Human-readable key name" }),
  enabled: t.Boolean({ description: "Whether the key currently authenticates" }),
  preview: t.Nullable(t.String({ description: "Non-secret start of the key (for identification)" })),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  expiresAt: t.Nullable(t.String({ description: "ISO 8601 expiry, null when the key never expires" })),
});

const ListResponseSchema = t.Object({
  keys: t.Array(KeyRowSchema, { description: "All system-wide API keys, newest first" }),
});

const CreateBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 64, description: "Key name shown in listings" }),
});

const CreateResponseSchema = t.Object({
  id: t.String({ description: "API key id (for later enable/disable/delete)" }),
  key: t.String({ description: "The plaintext key — shown exactly once, store it now" }),
});

const PatchBodySchema = t.Object({
  enabled: t.Boolean({ description: "Enable or disable the key (disable revokes instantly)" }),
});

const OkResponseSchema = t.Object({
  ok: t.Boolean({ description: "Always true on success" }),
});

/** Maps a raw apikey row to the admin-listing shape (hash never leaves the DB). */
function toKeyRow(row: ApiKeyListRow) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    preview: row.start,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Admin CRUD for system-wide API keys (spec §8). These are long-lived bearer
 * credentials owned by the `system` service user with no permission ceiling —
 * for LAN tooling and admin scripts, distinct from the ephemeral per-subshell
 * tokens. Management is cookie-admin only (requireAdmin rejects machine
 * actors), and the plaintext key is returned exactly once at creation; the
 * table only ever holds its hash. All apikey-table access goes through the
 * shared apikey-store (the plugin's own endpoints are subshell-guarded).
 */
export const systemKeysRoutes = new Elysia({ prefix: "/api/system-keys" })
  .use(requireAdmin)
  .get(
    "/",
    async () => {
      const systemUserId = await ensureSystemUser();
      return { keys: listSystemKeys(systemUserId).map(toKeyRow) };
    },
    {
      response: ListResponseSchema,
      detail: {
        operationId: "listSystemKeys",
        tags: ["system-keys"],
        description: "Lists admin-managed system API keys (never the secret)",
      },
    },
  )
  .post(
    "/",
    async ({ body, user }) => {
      const systemUserId = await ensureSystemUser();
      const created = (await auth.api.createApiKey({
        body: {
          name: body.name,
          userId: systemUserId,
          metadata: { kind: "system" },
        },
      })) as unknown as CreatedApiKey;
      await audit({
        actorUserId: user.id,
        action: "system-key.create",
        targetType: "api-key",
        targetId: created.id,
        metadataJson: JSON.stringify({ name: body.name }),
      });
      return { id: created.id, key: created.key };
    },
    {
      body: CreateBodySchema,
      response: CreateResponseSchema,
      detail: {
        operationId: "createSystemKey",
        tags: ["system-keys"],
        description: "Mints a system API key; the plaintext is returned only here",
      },
    },
  )
  .patch(
    "/:id",
    async ({ params, body, user }) => {
      const systemUserId = await ensureSystemUser();
      if (!isSystemKey(params.id, systemUserId)) throw new HttpError(404, "Key not found");
      setApiKeyEnabled(params.id, body.enabled);
      await audit({
        actorUserId: user.id,
        action: body.enabled ? "system-key.enable" : "system-key.disable",
        targetType: "api-key",
        targetId: params.id,
        metadataJson: null,
      });
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String({ description: "API key id" }) }),
      body: PatchBodySchema,
      response: OkResponseSchema,
      detail: {
        operationId: "updateSystemKey",
        tags: ["system-keys"],
        description: "Enables or disables a system key; disable revokes immediately",
      },
    },
  )
  .delete(
    "/:id",
    async ({ params, user }) => {
      const systemUserId = await ensureSystemUser();
      if (!isSystemKey(params.id, systemUserId)) throw new HttpError(404, "Key not found");
      deleteApiKey(params.id);
      await audit({
        actorUserId: user.id,
        action: "system-key.delete",
        targetType: "api-key",
        targetId: params.id,
        metadataJson: null,
      });
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String({ description: "API key id" }) }),
      response: OkResponseSchema,
      detail: {
        operationId: "deleteSystemKey",
        tags: ["system-keys"],
        description: "Deletes a system key and its row",
      },
    },
  );
