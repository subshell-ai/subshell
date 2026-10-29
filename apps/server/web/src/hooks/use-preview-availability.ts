import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { useSubshellServices } from "@/hooks/use-subshell-services";
import { shouldPollSavedServices, unsavedPreviewItemCount } from "@/lib/preview-badge";
import type { SubshellView } from "@/types/subshell";

/**
 * Header availability and the badge's number: items the picker could offer that this
 * pane has no saved service for. Both reads are the ones the picker itself
 * uses (same query keys), so a header and an open tab never disagree, and a
 * header with no row yet asks for nothing.
 */
export function usePreviewAvailability(id: string | undefined, subshell: SubshellView | undefined) {
  // Both hooks run on every render, and what varies is whether they ask: an
  // early return above them would change the hook order between renders. The
  // guard covers an empty id as well as its absence, because `""` would build
  // the path `/api/subshells//services` under a key no one else uses.
  const usable = id !== undefined && id !== "" && subshell !== undefined;
  const preview = useSubshellPreview(id ?? "", usable ? subshell : undefined);
  // The saved-services poll asks the same question the badge asks before
  // counting: node switched on, no reason attached, and an access level that
  // can act on what the count shows. `preview-ports-unsupported` answers with
  // the switch on and a reason at once, and a `view` grantee has no ports
  // counted at all, so either case would hold a five-second read whose data
  // is always discarded.
  const access = subshell?.access ?? "owner";
  const services = useSubshellServices(id ?? "", usable && shouldPollSavedServices(preview.info, access));
  const live = usable && subshell.status === "running" && subshell.alive;
  return {
    unsavedCount: live ? unsavedPreviewItemCount(preview.info, services.data, access) : 0,
    hasLiveItems: live && unsavedPreviewItemCount(preview.info, [], access) > 0,
  };
}
