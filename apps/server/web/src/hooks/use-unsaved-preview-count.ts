import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { useSubshellServices } from "@/hooks/use-subshell-services";
import { shouldPollSavedServices, unsavedPreviewItemCount } from "@/lib/preview-badge";
import type { SubshellView } from "@/types/subshell";

/**
 * The header badge's number: items the preview picker could offer that this
 * pane has no saved service for. Both reads are the ones the picker itself
 * uses (same query keys), so a header and an open tab never disagree, and a
 * header with no row yet asks for nothing.
 */
export function useUnsavedPreviewCount(id: string | undefined, subshell: SubshellView | undefined): number {
  // Both hooks run on every render, and what varies is whether they ask: an
  // early return above them would change the hook order between renders. The
  // guard covers an empty id as well as its absence, because `""` would build
  // the path `/api/subshells//services` under a key no one else uses.
  const usable = id !== undefined && id !== "" && subshell !== undefined;
  const preview = useSubshellPreview(id ?? "", usable ? subshell : undefined);
  // The saved-services poll asks the same question the badge asks before
  // counting: node switched on and no reason attached. `preview-ports-
  // unsupported` answers with both at once, which is why the switch alone is
  // not the gate: on a macOS pane it would hold a five-second poll whose data
  // is always discarded.
  const services = useSubshellServices(id ?? "", usable && shouldPollSavedServices(preview.info));
  return usable ? unsavedPreviewItemCount(preview.info, services.data) : 0;
}
