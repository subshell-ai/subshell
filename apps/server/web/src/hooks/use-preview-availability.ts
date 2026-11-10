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
  // counting: the node is switched on and the answer can offer rows. A
  // `preview-ports-unsupported` answer normally holds it off, but when the
  // harness reported ports the list is needed: it tells a reported row apart
  // from one the person already saved. A `view` grantee has no ports counted
  // at all, so their poll is always a discard.
  const access = subshell?.access ?? "owner";
  const services = useSubshellServices(id ?? "", usable && shouldPollSavedServices(preview.info, access));
  const live = usable && subshell.status === "running" && subshell.alive;
  return {
    unsavedCount: live ? unsavedPreviewItemCount(preview.info, services.data, access) : 0,
    hasLiveItems: live && unsavedPreviewItemCount(preview.info, [], access) > 0,
  };
}
