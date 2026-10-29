import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { gatePreview } from "@/api/subshells/preview-gate.js";
import { listServices, removeService, saveService } from "@/modules/subshells/saved-services.js";
import { PreviewConfigurationSchema } from "./preview-configuration-schema.js";

const ServiceBodySchema = t.Object({
  configuration: t.Optional(PreviewConfigurationSchema),
  ignoreCertificateErrors: t.Optional(t.Boolean()),
  name: t.Optional(t.String({ maxLength: 80 })),
  host: t.Optional(t.String({ minLength: 1, maxLength: 253 })),
  port: t.Integer({ minimum: 1, maximum: 65535 }),
  protocol: t.Union([t.Literal("http"), t.Literal("https")]),
});

/** Saved destinations use the same ownership/share boundary as interactive views. */
export const servicesRoute = new Elysia()
  .use(authGuard)
  .get(
    "/:id/services",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      await gatePreview(user.id, params.id, "view", actor);
      return listServices(params.id);
    },
    { systemPermission: "subshells:read", detail: { operationId: "listSubshellServices", tags: ["subshells"] } },
  )
  .post(
    "/:id/services",
    async ({ params, body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      await gatePreview(user.id, params.id, "edit", actor);
      return saveService(params.id, body, user.id);
    },
    {
      systemPermission: "subshells:execute",
      body: ServiceBodySchema,
      detail: { operationId: "saveSubshellService", tags: ["subshells"] },
    },
  )
  .put(
    "/:id/services/:serviceId",
    async ({ params, body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      await gatePreview(user.id, params.id, "edit", actor);
      return saveService(params.id, body, user.id, params.serviceId);
    },
    {
      systemPermission: "subshells:execute",
      body: t.Object({ ...ServiceBodySchema.properties, expectedRevision: t.Integer({ minimum: 0 }) }),
      detail: { operationId: "updateSubshellService", tags: ["subshells"] },
    },
  )
  .delete(
    "/:id/services/:serviceId",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      await gatePreview(user.id, params.id, "edit", actor);
      return removeService(params.id, params.serviceId, user.id);
    },
    { systemPermission: "subshells:execute", detail: { operationId: "removeSubshellService", tags: ["subshells"] } },
  );
