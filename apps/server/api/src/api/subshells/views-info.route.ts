import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { gatePreview, previewNodeState } from "@/api/subshells/preview-gate.js";
import { NodeRpcError } from "@/modules/nodes/node-rpc.js";
import { getVirtualDisplayEnabled, getWebPreviewsEnabled } from "@/modules/nodes/preview-enabled.js";
import { getPreviewBroker } from "@/modules/previews/preview-broker.js";
import { PREVIEW_PORTS_UNSUPPORTED } from "@/modules/previews/refusals.js";

/**
 * `GET /api/subshells/:id/views` (spec §6): what the pane currently offers
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
  display: t.String({ description: "Provider display identifier (for example :90)" }),
  viewer: t.Object(
    {
      protocol: t.Literal("vnc", { description: "Viewer protocol served by the provider" }),
      port: t.Integer({ minimum: 1, maximum: 65535, description: "Provider viewer port on the node's loopback" }),
    },
    { description: "Viewer connection for the allocated display" },
  ),
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
    t.String({
      maxLength: 128,
      description: "Set only beside screen null: which display process died since the pane launched",
    }),
  ),
  webPreviewsEnabled: t.Optional(t.Boolean()),
  virtualDisplayEnabled: t.Optional(t.Boolean()),
  nodeEnabled: t.Boolean({
    description: "Whether the pane's NODE can serve preview right now (switch, gates, link), not the pane",
  }),
  reason: t.Optional(
    t.String({
      description:
        "Why nodeEnabled is false: a plane word (preview-disabled, node-held, node-too-old, node-offline, node-timeout), the composed node-refused (code) or preview-refused for what the plane cannot name, or the node's own refusal word passed through verbatim; also carries the ports refusal word when nodeEnabled is true and the node itself refused the scan",
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
    if (err.code === "unsupported") {
      // The PLANE's own verdict that the connected agent predates the
      // command: it carries no `detail`, but it says exactly what the
      // detail-bearing refusal says. Same branch, same reason word.
      return { nodeEnabled: true, reason: PREVIEW_PORTS_UNSUPPORTED };
    }
    if (err.detail !== undefined && err.code === "failed") {
      if (err.detail === PREVIEW_PORTS_UNSUPPORTED) return { nodeEnabled: true, reason: PREVIEW_PORTS_UNSUPPORTED };
      return { nodeEnabled: false, reason: err.detail };
    }
    return { nodeEnabled: false, reason: `node-refused (${err.code})` };
  }
  // A malformed answer or a bug below: still not an error for a polling page.
  return { nodeEnabled: false, reason: "preview-refused" };
}

export const viewsInfoRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/views",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      const { row } = await gatePreview(user.id, params.id, "view", actor);
      const nodeId = row.nodeId;
      const nodeState = {
        ...(await previewNodeState(nodeId, "any")),
        webPreviewsEnabled: await getWebPreviewsEnabled(nodeId),
        virtualDisplayEnabled: await getVirtualDisplayEnabled(nodeId),
      };
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
        const broker = getPreviewBroker();
        const answer = await broker.getPorts(nodeId, params.id);
        // The launch ack names the screen before the node's own scan
        // reports it (the bridge is up when the ack flies; a scan can lag
        // it). The plane's memory may fill a null screen, but it never
        // masks a live answer and never overwrites a named screenLost: a
        // death the node reported outranks the plane's memory of the birth.
        const remembered =
          answer.screen === null && answer.screenLost === undefined ? broker.displayForPane(params.id) : null;
        return {
          ports: nodeState.webPreviewsEnabled ? answer.ports : [],
          cdpPort: nodeState.webPreviewsEnabled ? answer.cdpPort : null,
          screen: nodeState.virtualDisplayEnabled
            ? remembered && remembered.nodeId === nodeId
              ? remembered.screen
              : answer.screen
            : null,
          ...(!nodeState.virtualDisplayEnabled || answer.screenLost === undefined
            ? {}
            : { screenLost: answer.screenLost }),
          ...nodeState,
        };
      } catch (err) {
        return { ...EMPTY_PORTS, ...nodeState, ...mapPortsFailure(err) };
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
        operationId: "listSubshellViews",
        tags: ["subshells"],
        description:
          "What the pane currently offers to watch: listening ports, devtools port, virtual display, and whether its node can serve preview. Always answers, never errors, because the open pane view polls it",
      },
    },
  );
