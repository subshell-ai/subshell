import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { gatePreview, previewNodeState, recheckPreviewOpen } from "@/api/subshells/preview-gate.js";
import { NodeRpcError } from "@/modules/nodes/node-rpc.js";
import { getPreviewBroker, PreviewRefusal } from "@/modules/previews/preview-broker.js";
import { readPreviewProxySettings, savePreviewProxySettings } from "@/modules/previews/proxy-settings.js";
import { detailIsNodeOff, PREVIEW_PANE_GONE } from "@/modules/previews/refusals.js";
import { getService } from "@/modules/subshells/saved-services.js";
import { HttpError } from "@/shared/errors.js";

/**
 * `POST /api/subshells/:id/views/open` (spec §6): open one forward lane to
 * a pane port and hand out the proxy path. Forwarding a raw TCP lane is an
 * `edit` act; watching and reading are not. The ref is the proxy's only
 * secret, so it is minted here (the broker owns its whole lifecycle) and the
 * route ships nothing but `/pv/<ref>/` for the SPA to point a browser at.
 */

const PreviewOpenBodySchema = t.Union(
  [
    t.Object({
      port: t.Integer({
        minimum: 1,
        maximum: 65_535,
        description:
          "Loopback port on the subshell's node to forward. Saved serviceId targets use their stored host instead.",
      }),
    }),
    t.Object({
      serviceId: t.String({ format: "uuid", description: "Saved service whose host and protocol the node will use" }),
    }),
  ],
  { description: "Target to open or configure: a loopback port or a saved service" },
);

const PreviewOpenResponseSchema = t.Object({
  proxyBase: t.String({
    description: "Path prefix the SPA proxies the forwarded lane through, ending in a slash",
  }),
});

const PreviewSettingsSchema = t.Object(
  {
    rewriteUrls: t.Boolean({ description: "Rewrite app resource URLs through the preview" }),
    passHost: t.Boolean({ description: "Forward the preview host header to the app" }),
    rewriteRedirects: t.Boolean({ description: "Rewrite app redirects through the preview" }),
  },
  { description: "Personal proxy preferences to apply to this destination" },
);
const PreviewSettingsBodySchema = t.Object({
  target: PreviewOpenBodySchema,
  action: t.Union([t.Literal("read"), t.Literal("save"), t.Literal("reset")], {
    description: "Read, save, or reset your target preferences",
  }),
  settings: t.Optional(PreviewSettingsSchema),
});

export const viewsOpenRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/views/open",
    async ({ params, body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      const { row } = await gatePreview(user.id, params.id, "edit", actor);
      const transportState = await previewNodeState(row.nodeId, "any");
      if (!transportState.nodeEnabled)
        throw new HttpError(
          409,
          `Web previews & screens is not available on that node right now (${transportState.reason}).`,
        );
      const service = "serviceId" in body ? await getService(params.id, body.serviceId) : undefined;
      const port = service?.port ?? ("port" in body ? body.port : 0);
      const broker = getPreviewBroker();
      const remembered = broker.displayForPane(params.id);
      const scan = service ? null : await broker.getPorts(row.nodeId, params.id).catch(() => null);
      const screen = scan?.screen ?? (remembered?.nodeId === row.nodeId ? remembered.screen : null);
      const feature = !service && screen?.viewer.port === port ? "display" : "web-previews";
      const nodeState = await previewNodeState(row.nodeId, feature);
      if (!nodeState.nodeEnabled) {
        // The info poll already said this; arriving here means the page was
        // stale (or the switch moved mid-click). Say the same thing as a 409.
        throw new HttpError(
          409,
          feature === "display"
            ? "Virtual displays are disabled on this node."
            : `Web previews are not available on that node right now (${nodeState.reason}).`,
        );
      }
      try {
        const { ref } = await getPreviewBroker().openForward({
          viewerUserId: user.id,
          paneId: params.id,
          nodeId: row.nodeId,
          port,
          service: service ? { host: service.host, protocol: service.protocol } : undefined,
          serviceId: service?.id,
          proxySettings: await readPreviewProxySettings({
            userId: user.id,
            nodeId: row.nodeId,
            host: service?.host ?? "localhost",
            protocol: service?.protocol ?? "http",
            port,
          }),
          authorize: async () => {
            if (service) await getService(params.id, service.id);
            await recheckPreviewOpen(user.id, params.id, row.nodeId, "edit", actor, feature);
          },
        });
        return { proxyBase: `/pv/${ref}/` };
      } catch (err) {
        if (err instanceof PreviewRefusal) {
          // The broker's own caps (lanes over the per-pane/per-node cap):
          // named, 409, so the SPA can say "close a preview first".
          throw new HttpError(409, `${err.code}: ${err.message}`);
        }
        if (err instanceof NodeRpcError) {
          if (err.code === "offline") {
            throwApiOffline();
          }
          if (err.code === "failed" && err.detail !== undefined) {
            if (err.detail.startsWith(PREVIEW_PANE_GONE) || detailIsNodeOff(err.detail)) {
              throw new HttpError(409, err.detail);
            }
            throw new HttpError(409, `That node refused the view: ${err.detail}`);
          }
          if (err.code === "timeout") {
            throw new HttpError(409, "The node did not answer the view request in time. Try again in a moment.");
          }
          // `unsupported`: the connected agent predates the preview command.
          throw new HttpError(
            409,
            "That node does not support web previews and screens yet. Update the node, then retry.",
          );
        }
        throw err;
      }
    },
    {
      body: PreviewOpenBodySchema,
      response: {
        200: PreviewOpenResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "openSubshellView",
        tags: ["subshells"],
        description:
          "Open a loopback port or saved serviceId and return its private proxy path. Requires edit access. Saved services use their stored host and HTTP/HTTPS protocol.",
      },
    },
  )
  .post(
    "/:id/views/settings",
    async ({ params, body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      const { row } = await gatePreview(user.id, params.id, "edit", actor);
      await recheckPreviewOpen(user.id, params.id, row.nodeId, "edit", actor, "any");
      const service = "serviceId" in body.target ? await getService(params.id, body.target.serviceId) : undefined;
      const target = {
        userId: user.id,
        nodeId: row.nodeId,
        host: service?.host ?? "localhost",
        protocol: service?.protocol ?? "http",
        port: service?.port ?? ("port" in body.target ? body.target.port : 0),
      };
      if (body.action === "read") return readPreviewProxySettings(target);
      if (body.action === "reset") return savePreviewProxySettings(target, null);
      if (!body.settings) throw new HttpError(400, "Choose the preview settings to save.");
      return savePreviewProxySettings(target, body.settings);
    },
    {
      body: PreviewSettingsBodySchema,
      response: {
        200: PreviewSettingsSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: { operationId: "previewProxySettings", tags: ["subshells"] },
    },
  );

/** The one 409 every "cannot talk to that node" branch renders. */
function throwApiOffline(): never {
  throw new HttpError(409, "That node is not connected right now. Reconnect it, or watch the pane's screen instead.");
}
