import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { gatePreview, previewNodeState, recheckPreviewOpen } from "@/api/subshells/preview-gate.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { detailIsNodeOff, PREVIEW_PANE_GONE } from "@/services/nodes/preview-refusals.js";
import { getPreviewBroker, PreviewRefusal } from "@/services/preview-broker.js";

/**
 * `POST /api/subshells/:id/views/open` (spec §6): open one forward lane to
 * a pane port and hand out the proxy path. Forwarding a raw TCP lane is an
 * `edit` act; watching and reading are not. The ref is the proxy's only
 * secret, so it is minted here (the broker owns its whole lifecycle) and the
 * route ships nothing but `/pv/<ref>/` for the SPA to point a browser at.
 */

const PreviewOpenBodySchema = t.Object({
  port: t.Integer({
    minimum: 1,
    maximum: 65_535,
    description: "Loopback port inside the pane's machine to forward (the node dials loopback only)",
  }),
});

const PreviewOpenResponseSchema = t.Object({
  proxyBase: t.String({
    description: "Path prefix the SPA proxies the forwarded lane through, ending in a slash",
  }),
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
      const nodeState = await previewNodeState(row.nodeId);
      if (!nodeState.nodeEnabled) {
        // The info poll already said this; arriving here means the page was
        // stale (or the switch moved mid-click). Say the same thing as a 409.
        throw new HttpError(409, `Apps & screens is not available on that node right now (${nodeState.reason}).`);
      }
      try {
        const { ref } = await getPreviewBroker().openForward({
          viewerUserId: user.id,
          paneId: params.id,
          nodeId: row.nodeId,
          port: body.port,
          authorize: async () => {
            await recheckPreviewOpen(user.id, params.id, row.nodeId, "edit", actor);
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
          throw new HttpError(409, "That node does not support apps and screens yet. Update the node, then retry.");
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
          "Open a forward lane to one loopback port of the pane and return the proxy path. Needs edit: the raw lane is the pane's own protocol, not a rendered view",
      },
    },
  );

/** The one 409 every "cannot talk to that node" branch renders. */
function throwApiOffline(): never {
  throw new HttpError(409, "That node is not connected right now. Reconnect it, or watch the pane's screen instead.");
}
