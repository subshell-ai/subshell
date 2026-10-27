import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { useSubshellServices } from "@/hooks/use-subshell-services";
import { unsavedPreviewItemCount } from "@/lib/preview-badge";
import type { SubshellView } from "@/types/subshell";

/**
 * The header badge's number: items the preview picker could offer that this
 * pane has no saved service for. Both reads are the ones the picker itself
 * uses (same query keys), so a header and an open tab never disagree, and a
 * header with no row yet asks for nothing.
 */
export function useUnsavedPreviewCount(id: string | undefined, subshell: SubshellView | undefined): number {
  const preview = useSubshellPreview(id ?? "", id ? subshell : undefined);
  const services = useSubshellServices(id ?? "", id !== undefined && subshell !== undefined);
  if (!id || !subshell) return 0;
  return unsavedPreviewItemCount(preview.info, services.data);
}
