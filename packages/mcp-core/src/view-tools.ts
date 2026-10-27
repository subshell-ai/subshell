import {
  DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
  displayProviderRunsOnOs,
  type NodePreviewScreenWire,
  parsePreviewDisplayReadiness,
  VIRTUAL_DISPLAY_PROVIDERS,
} from "@internal/subshell-protocol";
import { z } from "zod";
import { ApiError } from "./api-client.js";
import { listNodes, resolveNodeId } from "./subshell-tools.js";
import type { ToolDeps } from "./tools.js";

export const ScreenSchema = z
  .object({
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .optional()
      .describe("Enabled provider ID from get_node; omitted uses the node default"),
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096),
  })
  .describe(
    "Allocate a virtual display using an enabled provider at launch; omit provider to use the node default. Check get_node first; virtual displays must already be enabled and the provider’s requirements met.",
  );

export const GetNodeSchema = z.object({
  node: z.string().min(1).describe("Node ID or unambiguous name from list_nodes"),
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .optional()
    .describe("Check this provider; omitted checks the node default"),
  check_display: z
    .boolean()
    .optional()
    .describe("Check display prerequisites live (default true); false returns discovery facts only"),
});

/** Read the same owner-only projection as list_nodes, never management details. */
export async function getNode(deps: ToolDeps, args: z.infer<typeof GetNodeSchema>) {
  const id = await resolveNodeId(deps, args.node);
  const node = (await listNodes(deps)).find((n) => n.id === id);
  if (!node) throw new Error("subshell: node is no longer available; call list_nodes again");
  if (args.check_display === false) return { ...node, virtualDisplay: { status: "unchecked" } };
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
      await deps.api.req(
        `/api/nodes/${encodeURIComponent(node.id)}/display-readiness${args.provider ? `?provider=${encodeURIComponent(args.provider)}` : ""}`,
      ),
    );
    if (!readiness) throw new Error("subshell: invalid display readiness response; update the server and retry");
    // `enabled` is the plane's whole gate, the same four checks
    // `resolveNodeDisplayRequest` makes, so an agent that trusts it is never
    // surprised by the create: the switch, the catalog (an id we do not ship is
    // refused outright, even when the owner's stored list carries it), the stored
    // enabled list, whose absent answer is `[DEFAULT_VIRTUAL_DISPLAY_PROVIDER]`, and
    // whether this provider runs on this node's operating system. The fourth one
    // used to be left to `status` on the theory that it is the machine's answer. That
    // held only while the probe answered: on a 409 or 502 the tool said
    // `enabled: true, status: "unavailable"` for BetterDisplay on a Linux node, and
    // the launch it recommended was refused. `displayProviderRunsOnOs` stays true for
    // an OS the node has not reported yet, which is what the plane does too.
    const provider = args.provider ?? node.virtualDisplayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER;
    const allowed = node.virtualDisplayProviders ?? [DEFAULT_VIRTUAL_DISPLAY_PROVIDER];
    return {
      ...node,
      virtualDisplay: {
        ...readiness,
        provider,
        enabled:
          node.virtualDisplayEnabled === true &&
          VIRTUAL_DISPLAY_PROVIDERS.some((entry) => entry.id === provider) &&
          allowed.includes(provider) &&
          displayProviderRunsOnOs(provider, node.os),
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

export const ListSubshellViewsSchema = z.object({ subshell_id: z.string().min(1) });
interface PreviewInfo {
  ports: { proto: string; port: number; pid: number }[];
  cdpPort: number | null;
  screen: NodePreviewScreenWire | null;
  nodeEnabled: boolean;
  webPreviewsEnabled?: boolean;
  virtualDisplayEnabled?: boolean;
  reason?: string;
}
export function listSubshellViews(deps: ToolDeps, args: z.infer<typeof ListSubshellViewsSchema>): Promise<PreviewInfo> {
  return deps.api.req(`/api/subshells/${encodeURIComponent(args.subshell_id)}/views`);
}

export const OpenSubshellViewSchema = z
  .object({
    subshell_id: z.string().min(1),
    kind: z.enum(["app", "screen"]),
    port: z.number().int().min(1).max(65535).optional().describe("Required for web previews; omit for screen previews"),
  })
  .superRefine((args, ctx) => {
    if (args.kind === "app" && args.port === undefined) {
      ctx.addIssue({ code: "custom", path: ["port"], message: "Choose an app port from list_subshell_views." });
    }
    if (args.kind === "screen" && args.port !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["port"],
        message: "Omit port for a virtual display; its screen port is discovered automatically.",
      });
    }
  });

export async function openSubshellView(deps: ToolDeps, args: z.infer<typeof OpenSubshellViewSchema>) {
  let port: number;
  if (args.kind === "screen") {
    const info = await listSubshellViews(deps, args);
    if (info.virtualDisplayEnabled === false)
      throw new Error(
        "subshell: virtual displays are disabled on this node; ask its owner to enable Allow virtual displays in node settings",
      );
    if (!info.nodeEnabled || !info.screen)
      throw new Error(
        "subshell: this subshell has no available virtual display; check get_node for provider requirements, then launch with screen on a prepared node",
      );
    port = info.screen.viewer.port;
  } else {
    if (args.port === undefined) throw new Error("subshell: web previews require a port from list_subshell_views");
    port = args.port;
  }
  const result = await deps.api.req<{ proxyBase: string }>(
    `/api/subshells/${encodeURIComponent(args.subshell_id)}/views/open`,
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

export const WatchSubshellBrowserSchema = z.object({
  subshell_id: z.string().min(1),
  on: z.boolean(),
  port: z.number().int().min(1).max(65535).optional(),
});
export function watchSubshellBrowser(deps: ToolDeps, args: z.infer<typeof WatchSubshellBrowserSchema>) {
  return deps.api.req(
    `/api/subshells/${encodeURIComponent(args.subshell_id)}/views/browser/watch`,
    args.on ? { method: "POST", body: args.port === undefined ? {} : { port: args.port } } : { method: "DELETE" },
  );
}
