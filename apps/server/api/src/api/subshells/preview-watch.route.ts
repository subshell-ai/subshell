import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { gatePreview, previewNodeState } from "@/api/subshells/preview-gate.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { PREVIEW_PORTS_UNSUPPORTED } from "@/services/nodes/preview-refusals.js";
import { getPreviewBroker, PreviewRefusal } from "@/services/preview-broker.js";

/**
 * The screencast watch doors, one file per resource rule: `POST
 * /api/subshells/:id/preview/watch` starts the pane's ONE screencast bridge,
 * `DELETE /api/subshells/:id/preview/watch` says "this viewer is done".
 * Watching is read-side (the node only ever sends devtools screencast
 * frames), so both doors sit at `view`, the same split `open` draws at
 * `edit`.
 *
 * No ref is handed out and none is needed: the bridge is keyed by pane and
 * every viewer of it shares one, so stop is pane-keyed too. A DELETE with no
 * bridge is a no-op, 200 (the caller unsubscribes, idempotently); the route
 * never asks whether one exists, because `stopWatch` already answers that
 * question truthfully and a route-side hunt would be a second answer.
 *
 * POST without a `port` falls back to the pane's cached `cdpPort` through the
 * broker (its 5 s cache is what makes the poll cheap); a pane with neither
 * gets a 400 naming what is missing. A port the LIVE bridge does not hold is
 * the broker's `watch-port-conflict` refusal, surfaced as a named 409.
 */

const PreviewWatchBodySchema = t.Object({
  port: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: 65_535,
      description: "Devtools port to screencast; omitted falls back to the pane's cached cdpPort",
    }),
  ),
});

const PreviewWatchResponseSchema = t.Object({
  ok: t.Literal(true, { description: "The bridge is running (or, for DELETE, the viewer's interest is withdrawn)" }),
});

export const previewWatchRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/preview/watch",
    async ({ params, body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      const { row } = await gatePreview(user.id, params.id, "view", actor);
      const nodeState = await previewNodeState(row.nodeId);
      if (!nodeState.nodeEnabled) {
        throw new HttpError(409, `Preview is not available on that node right now (${nodeState.reason}).`);
      }
      const broker = getPreviewBroker();
      let port = body.port;
      if (port === undefined) {
        // The cached ports answer is the fallback; a failure here is mapped,
        // because the caller asked the pane, not the cache, what to watch.
        try {
          port = (await broker.getPorts(row.nodeId, params.id)).cdpPort ?? undefined;
        } catch (err) {
          if (err instanceof NodeRpcError && err.code === "failed" && err.detail === PREVIEW_PORTS_UNSUPPORTED) {
            throw new HttpError(400, `That node cannot scan its panes' ports (${err.detail}). Pass a port directly.`);
          }
          if (err instanceof NodeRpcError && err.code === "offline") {
            throw new HttpError(409, "That node is not connected right now. Reconnect it, then watch again.");
          }
          throw new HttpError(409, "The pane's open ports could not be read. Pass a port directly.");
        }
        if (port === undefined) {
          throw new HttpError(
            400,
            "The request named no port and the pane has no cached cdpPort to fall back to. Pass a port, or let a devtools port be seen first.",
          );
        }
      }
      try {
        await broker.startWatch({ viewerUserId: user.id, paneId: params.id, nodeId: row.nodeId, port });
        return { ok: true } as const;
      } catch (err) {
        if (err instanceof PreviewRefusal) {
          // watch-port-conflict (the bridge is busy on another port) and the
          // watch cap, both named (Task 8 owns the rule; the route owes the
          // SPA a 409 that says which).
          throw new HttpError(409, `${err.code}: ${err.message}`);
        }
        if (err instanceof NodeRpcError && err.code === "failed" && err.detail !== undefined) {
          // The node's refusal of the screencast open (`not-cdp`, pane gone,
          // switch off mid-call): pass the word through named.
          throw new HttpError(409, `That node refused the watch: ${err.detail}`);
        }
        if (err instanceof NodeRpcError && err.code === "offline") {
          throw new HttpError(409, "That node is not connected right now. Reconnect it, then watch again.");
        }
        throw err;
      }
    },
    {
      body: PreviewWatchBodySchema,
      response: {
        200: PreviewWatchResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:read",
      detail: {
        operationId: "startSubshellPreviewWatch",
        tags: ["subshells"],
        description:
          "Start (or join) the pane's single screencast bridge. A missing port falls back to the cached cdpPort; with neither, the refusal says what is missing",
      },
    },
  )
  .delete(
    "/:id/preview/watch",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      await gatePreview(user.id, params.id, "view", actor);
      // Pane-keyed and idempotent: the broker decides whether this was the
      // last viewer; a second DELETE changes nothing and still answers ok.
      await getPreviewBroker().stopWatch(user.id, params.id);
      return { ok: true } as const;
    },
    {
      response: {
        200: PreviewWatchResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      systemPermission: "subshells:read",
      detail: {
        operationId: "stopSubshellPreviewWatch",
        tags: ["subshells"],
        description:
          "Withdraw this viewer's interest in the pane's screencast. Idempotent: no bridge open is a success, not a hunt",
      },
    },
  );
