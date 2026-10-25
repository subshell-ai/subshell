import {
  DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
  parseVirtualDisplayRequest,
  storedDisplayProviderIds,
  VIRTUAL_DISPLAY_PROVIDERS,
  type VirtualDisplayRequest,
} from "@internal/subshell-protocol";
import { HttpError } from "@/api/auth-guard.js";
import { getRequestlessContext } from "@/lib/context.js";

/** Resolve once before saving a subshell; restart supplies its pinned provider. */
export async function resolveNodeDisplayRequest(
  nodeId: string,
  request: VirtualDisplayRequest,
  status = 400,
): Promise<VirtualDisplayRequest & { provider: string }> {
  if (!parseVirtualDisplayRequest(request))
    throw new HttpError(status, "The virtual display settings are invalid. Choose a provider and display size again.");
  const row = await getRequestlessContext().repos.nodes.findById(nodeId);
  if (row?.virtualDisplayEnabled !== 1)
    throw new HttpError(
      status,
      "Virtual displays are disabled on this node. Enable Allow virtual displays in node settings before starting this subshell.",
    );
  const provider = request.provider ?? row.virtualDisplayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER;
  if (!VIRTUAL_DISPLAY_PROVIDERS.some((p) => p.id === provider))
    throw new HttpError(
      status,
      "This virtual display provider is unavailable. Choose an available provider for a new subshell.",
    );
  if (!storedDisplayProviderIds(row.virtualDisplayProviders).includes(provider))
    throw new HttpError(
      status,
      "This virtual display provider is disabled on the node. Enable it in node settings or choose another provider for a new subshell.",
    );
  return { ...request, provider };
}
