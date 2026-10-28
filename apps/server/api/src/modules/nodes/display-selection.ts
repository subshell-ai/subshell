import {
  DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
  displayProviderRunsOnOs,
  parseVirtualDisplayRequest,
  storedDisplayProviderIds,
  VIRTUAL_DISPLAY_PROVIDERS,
  type VirtualDisplayRequest,
} from "@internal/subshell-protocol";
import { getRequestlessContext } from "@/app/context.js";
import { HttpError } from "@/shared/errors.js";

/** The node's own refusal word, carried in the tail of a plane refusal. */
const NODE_OFF = "preview-node-off";
const PROVIDER_UNSUPPORTED = "preview-display-unsupported";
const PROVIDER_DISABLED = "preview-display-provider-disabled";

/**
 * One refusal, in the shape the dashboard routes on.
 *
 * The word rides at the end because that ending is what decides WHERE the
 * sentence appears: `isDisplayLaunchRefusal` matches a `(preview-display-…)` or
 * `(preview-node-off)` tail and keeps the refusal beside the **Virtual display**
 * checkbox whose setting caused it. A plane refusal without the word lands at the
 * bottom of the form instead, so the same failure read differently depending on
 * which side noticed it. The words are the node's, never invented here: the
 * operator greps one vocabulary.
 */
function refused(status: number, sentence: string, word: string): never {
  throw new HttpError(status, `${sentence} (${word})`);
}

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
    refused(
      status,
      "Virtual displays are disabled on this node. Enable Allow virtual displays in node settings before starting this subshell.",
      NODE_OFF,
    );
  const provider = request.provider ?? row.virtualDisplayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER;
  if (!VIRTUAL_DISPLAY_PROVIDERS.some((p) => p.id === provider))
    refused(
      status,
      "This virtual display provider is unavailable. Choose an available provider for a new subshell.",
      PROVIDER_UNSUPPORTED,
    );
  // The catalog knows which machine each provider drives and the row knows which
  // machine this is, so asking the agent costs a row, a minted token, a signed
  // command, and a rollback for a screen that cannot exist. An `os` that has not
  // answered is no verdict (`displayProviderRunsOnOs`): a node that could not
  // classify itself keeps the provider its own readiness check will accept.
  if (!displayProviderRunsOnOs(provider, row.os))
    refused(
      status,
      "This virtual display provider does not run on this node's operating system. Choose a provider this machine supports, or launch without a virtual display.",
      PROVIDER_UNSUPPORTED,
    );
  if (!storedDisplayProviderIds(row.virtualDisplayProviders).includes(provider))
    refused(
      status,
      "This virtual display provider is disabled on the node. Enable it in node settings or choose another provider for a new subshell.",
      PROVIDER_DISABLED,
    );
  return { ...request, provider };
}
