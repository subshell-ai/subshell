import { parsePreviewDisplayReadiness } from "@internal/subshell-protocol";
import { z } from "zod";
import { ApiError } from "./api-client.js";
import { listNodes, resolveNodeId } from "./subshell-tools.js";
import type { ToolDeps } from "./tools.js";

export const ScreenSchema = z
  .object({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096),
  })
  .describe(
    "Allocate a Linux virtual display at launch. Check get_node first; Preview must already be enabled and display programs installed.",
  );

export const GetNodeSchema = z.object({
  node: z.string().min(1).describe("Node ID or unambiguous name from list_nodes"),
  check_preview: z
    .boolean()
    .optional()
    .describe("Check display prerequisites live (default true); false returns discovery facts only"),
});

/** Read the same owner-only projection as list_nodes, never management details. */
export async function getNode(deps: ToolDeps, args: z.infer<typeof GetNodeSchema>) {
  const id = await resolveNodeId(deps, args.node);
  const node = (await listNodes(deps)).find((n) => n.id === id);
  if (!node) throw new Error("subshell: node is no longer available; call list_nodes again");
  if (args.check_preview === false) return { ...node, virtualDisplay: { status: "unchecked" } };
  if (node.os && node.os !== "linux")
    return {
      ...node,
      virtualDisplay: { status: "unsupported", supported: false, reason: "Virtual displays require Linux." },
    };
  if (node.status !== "online" || node.held)
    return {
      ...node,
      virtualDisplay: {
        status: "unavailable",
        reason: "Bring the node online and resolve any connection hold before checking.",
      },
    };
  try {
    const readiness = parsePreviewDisplayReadiness(
      await deps.api.req(`/api/nodes/${encodeURIComponent(node.id)}/preview-display`),
    );
    if (!readiness) throw new Error("subshell: invalid display readiness response; update the server and retry");
    return {
      ...node,
      virtualDisplay: {
        ...readiness,
        status: !readiness.supported ? "unsupported" : readiness.missing.length ? "missing-programs" : "ready",
      },
    };
  } catch (err) {
    // Authorization errors remain errors; an unavailable probe is not evidence
    // that the platform or its installed programs lack support.
    if (err instanceof ApiError && [409, 502].includes(err.status))
      return { ...node, virtualDisplay: { status: "unavailable", reason: err.message } };
    throw err;
  }
}

export const GetPreviewSchema = z.object({ subshell_id: z.string().min(1) });
interface PreviewInfo {
  ports: { proto: string; port: number; pid: number }[];
  cdpPort: number | null;
  screen: { display: string; rfbPort: number } | null;
  nodeEnabled: boolean;
  reason?: string;
}
export function getPreview(deps: ToolDeps, args: z.infer<typeof GetPreviewSchema>): Promise<PreviewInfo> {
  return deps.api.req(`/api/subshells/${encodeURIComponent(args.subshell_id)}/preview`);
}

export const OpenPreviewSchema = z.object({
  subshell_id: z.string().min(1),
  kind: z.enum(["app", "screen"]),
  port: z.number().int().min(1).max(65535).optional().describe("Required for app previews; omit for screen previews"),
});
export async function openPreview(deps: ToolDeps, args: z.infer<typeof OpenPreviewSchema>) {
  let port: number;
  if (args.kind === "screen") {
    const info = await getPreview(deps, args);
    if (!info.nodeEnabled || !info.screen)
      throw new Error(
        "subshell: this subshell has no available virtual display; check get_preview and launch with screen on a prepared Linux node",
      );
    port = info.screen.rfbPort;
  } else {
    if (args.port === undefined) throw new Error("subshell: app previews require a port from get_preview");
    port = args.port;
  }
  const result = await deps.api.req<{ proxyBase: string }>(
    `/api/subshells/${encodeURIComponent(args.subshell_id)}/preview/open`,
    { method: "POST", body: { port } },
  );
  return {
    ...result,
    kind: args.kind,
    port,
    note:
      args.kind === "screen"
        ? "Private capability path for the screen viewer's WebSocket. Use Virtual display in the dashboard to control it. This call does not open a workspace tab."
        : "Private capability path relative to the server URL. Anyone with the complete link can use it while valid. This call does not open a workspace tab.",
  };
}

export const WatchPreviewSchema = z.object({
  subshell_id: z.string().min(1),
  on: z.boolean(),
  port: z.number().int().min(1).max(65535).optional(),
});
export function watchPreview(deps: ToolDeps, args: z.infer<typeof WatchPreviewSchema>) {
  return deps.api.req(
    `/api/subshells/${encodeURIComponent(args.subshell_id)}/preview/watch`,
    args.on ? { method: "POST", body: args.port === undefined ? {} : { port: args.port } } : { method: "DELETE" },
  );
}
