import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { gatePreview, previewNodeState } from "@/api/subshells/preview-gate.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { PREVIEW_PORTS_UNSUPPORTED } from "@/services/nodes/preview-refusals.js";
import { getPreviewBroker } from "@/services/preview-broker.js";

/**
 * `GET /api/subshells/:id/preview` (spec §6): what the pane currently offers
 * to watch. The answer is ALWAYS this shape, never an error, because the
 * open pane view polls it: an unreachable node, a switched-off machine, a
 * platform without the ports scan, and a pane that is simply gone each read
 * as the same fields with `nodeEnabled` and `reason` carrying the truth.
 *
 * Two shape rules carry weight. A switch-on node that refuses the ports scan
 * for platform reasons answers `nodeEnabled: true` with the refusal NAMED in
 * `reason` (a node that cannot speak is still online; a blank `[]` with no
 * reason reads as "nothing is listening" and lies about why). And a closed
 * pane short-circuits route-side to the empty shape without any RPC: the
 * refusal-mapping rule is for live panes whose node-side answer failed, and
 * a pane that is gone has no display that could die, so no `screenLost`.
 */

const PreviewPortSchema = t.Object({
  proto: t.Union([t.Literal("tcp"), t.Literal("tcp6")], {
    description: "Address family the listener is on",
  }),
  port: t.Integer({ description: "Listening port on the pane's machine (loopback)" }),
  pid: t.Integer({ description: "Process holding the listener, inside the pane's tree" }),
});

const PreviewScreenSchema = t.Object({
  display: t.String({ description: "X display the pane's virtual screen runs on (for example :90)" }),
  rfbPort: t.Integer({ description: "Loopback RFB (VNC) port the screencast bridge reads from" }),
});

const PreviewInfoResponseSchema = t.Object({
  ports: t.Array(PreviewPortSchema, {
    description: "Listening sockets in the pane's process tree; empty when there are none or the node cannot answer",
  }),
  cdpPort: t.Nullable(t.Integer({ description: "The pane's open devtools port, or null when nothing speaks CDP" })),
  screen: t.Nullable(PreviewScreenSchema, {
    description: "The pane's virtual display when it has one, or null (never a guess)",
  }),
  screenLost: t.Optional(
    t.Union([t.Literal("Xvfb"), t.Literal("x11vnc")], {
      description: "Set only beside screen null: which display process died since the pane launched",
    }),
  ),
  nodeEnabled: t.Boolean({
    description: "Whether the pane's NODE can serve preview right now (switch, gates, link), not the pane",
  }),
  reason: t.Optional(
    t.String({
      description:
        "Why nodeEnabled is false (preview-disabled, node-held, node-too-old, node-offline, or the node's named refusal); also carries the ports refusal word when nodeEnabled is true and the node itself refused the scan",
    }),
  ),
});

/** The empty shape for every "the node cannot answer" branch. */
const EMPTY_PORTS = { ports: [] as never[], cdpPort: null, screen: null } as const;

/** Map a failed `preview_ports_get` onto spec §6's nodeEnabled/reason pair. */
function mapPortsFailure(err: unknown): { nodeEnabled: boolean; reason: string } {
  if (err instanceof NodeRpcError) {
    if (err.code === "offline") return { nodeEnabled: false, reason: "node-offline" };
    if (err.code === "timeout") return { nodeEnabled: false, reason: "node-timeout" };
    // The agent's own refusal, passed through NAMED (the wire-constant
    // habit). `preview-ports-unsupported` keeps `nodeEnabled: true`: the
    // node is online and switched on, it just has no /proc to read.
    if (err.detail !== undefined && err.code === "failed") {
      if (err.detail === PREVIEW_PORTS_UNSUPPORTED) return { nodeEnabled: true, reason: PREVIEW_PORTS_UNSUPPORTED };
      return { nodeEnabled: false, reason: err.detail };
    }
    return { nodeEnabled: false, reason: `node-refused (${err.code})` };
  }
  // A malformed answer or a bug below: still not an error for a polling page.
  return { nodeEnabled: false, reason: "preview-refused" };
}

export const previewInfoRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/preview",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      const { row } = await gatePreview(user.id, params.id, "view", actor);
      const nodeId = row.nodeId;
      const nodeState = await previewNodeState(nodeId);
      // A pane that is not running is answered route-side, with no RPC:
      // short-circuit order is closed-first so a dead row on a live node
      // still says "no ports, no screen", and nodeState keeps describing
      // the NODE rather than the pane.
      if (row.status !== "running") {
        return { ...EMPTY_PORTS, ...nodeState };
      }
      if (!nodeState.nodeEnabled) {
        return { ...EMPTY_PORTS, ...nodeState };
      }
      try {
        const answer = await getPreviewBroker().getPorts(nodeId, params.id);
        return {
          ports: answer.ports,
          cdpPort: answer.cdpPort,
          screen: answer.screen,
          ...(answer.screenLost === undefined ? {} : { screenLost: answer.screenLost }),
          nodeEnabled: true,
        };
      } catch (err) {
        return { ...EMPTY_PORTS, ...mapPortsFailure(err) };
      }
    },
    {
      response: {
        200: PreviewInfoResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      systemPermission: "subshells:read",
      detail: {
        operationId: "getSubshellPreviewInfo",
        tags: ["subshells"],
        description:
          "What the pane currently offers to watch: listening ports, devtools port, virtual display, and whether its node can serve preview. Always answers, never errors, because the open pane view polls it",
      },
    },
  );
