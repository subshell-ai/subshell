import { BackendErrorCodes } from "@internal/backend-errors";
import {
  DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
  storedDisplayProviderIds,
  VIRTUAL_DISPLAY_PROVIDERS,
} from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { apiModels } from "@/api/schemas/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { setPreviewEnabled } from "@/modules/nodes/preview-enabled.js";
import { ForbiddenError, HttpError } from "@/shared/errors.js";

const PreviewEnabledBodySchema = t.Object({
  providers: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 64, description: "Enabled provider identifier" }), {
      maxItems: 32,
      uniqueItems: true,
      description: "Providers allowed for new virtual displays",
    }),
  ),
  provider: t.Optional(
    t.String({ minLength: 1, maxLength: 64, description: "Bundled provider for new virtual displays on this node" }),
  ),
  feature: t.Optional(t.Union([t.Literal("web-previews"), t.Literal("display")])),
  on: t.Boolean({
    description:
      "Allow the selected feature on this machine. Web previews apply to every subshell; virtual displays must be requested at launch. Off by default. Owner only; admin on the control-plane host.",
  }),
});

/**
 * `PUT /api/nodes/:id/views-enabled` `{on}`: open or close pane preview on
 * one machine (pane-preview spec Task 3). Browser session or an API key
 * holding the `nodes:preview` grant.
 *
 * **OWNER-only** (`gate.canManage`, with the seeded-`local` admin exception),
 * the same gate as SSH and maintenance: a grantee may restart the agent or
 * read its log, but deciding whether this machine's pane content may be
 * watched is not theirs. The permission is its OWN catalog id, not
 * `nodes:ssh`. A key scoped to SSH must not be able to flip preview; the
 * grants answer different questions.
 *
 * The route writes nothing and audits nothing itself: `setPreviewEnabled` is
 * the one change-site (row + audit + push), so no caller can perform half the
 * act. The route is the only place the acting human is wired in.
 *
 * It answers on an OFFLINE node rather than refusing: the flag is the plane's
 * record, and the machine learns the value at its next `ready` reconcile.
 * Refusing would make the flag settable only while the machine is reachable,
 * which is backwards for a gate that exists to be closed.
 */
export const setNodeViewsEnabledRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .put(
    "/:id/views-enabled",
    async ({ params, body, user, actor, status }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      if (
        body.provider &&
        (body.feature !== "display" || !VIRTUAL_DISPLAY_PROVIDERS.some((p) => p.id === body.provider))
      )
        throw new HttpError(400, "Choose an available virtual display provider.");
      let providers: string[] | undefined;
      let provider = body.provider;
      if (body.providers !== undefined && body.feature !== "display")
        throw new HttpError(400, "Provider settings apply only to virtual displays.");
      if (body.feature === "display") {
        providers = body.providers ?? storedDisplayProviderIds(gate.row.virtualDisplayProviders);
        if (providers.some((id) => !VIRTUAL_DISPLAY_PROVIDERS.some((p) => p.id === id)))
          throw new HttpError(400, "Choose available virtual display providers.");
        provider ??= gate.row.virtualDisplayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER;
        if (providers.length && !providers.includes(provider)) {
          if (body.provider) throw new HttpError(400, "The default display provider must be enabled on this node.");
          provider = providers[0];
        }
      }
      await setPreviewEnabled(gate.row.id, user.id, body.on, body.feature, provider, providers);
      // Re-read rather than patching the gate's snapshot: the service wrote
      // the row, and the view must render what is stored, not what this
      // handler believes it asked for.
      const row = (await new NodesRepository(db).findById(gate.row.id)) ?? gate.row;
      return await toNodeView(row, gate.access, gate.isAdmin, gate.granted);
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: PreviewEnabledBodySchema,
      response: {
        200: NodeViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      systemPermission: "nodes:preview",
      detail: {
        operationId: "setNodeViewsEnabled",
        tags: ["nodes"],
        description:
          "Enable or disable web previews and virtual displays on a node (owner only; admin on the control-plane host). Off by default; enabling lets authorized viewers watch this machine's pane content.",
      },
    },
  );
