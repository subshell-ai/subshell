import { type PreviewChoice, PreviewSection } from "@/components/preview/preview-section";
import type { PreviewWorkspaceControls } from "@/components/preview/preview-toolbar";
import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { useSubshellRow } from "@/hooks/use-subshell-row";

/** Mounted only while the preview tab is visible, so hidden tabs release their lanes. */
export function PreviewTabContent({
  subshellId,
  choice,
  onClose,
  workspace,
}: {
  subshellId: string;
  choice: PreviewChoice;
  onClose: () => void;
  workspace?: PreviewWorkspaceControls;
}) {
  const subshell = useSubshellRow(subshellId);
  const preview = useSubshellPreview(subshellId, subshell);
  if (!subshell) return <p className="p-3 text-detail text-muted-foreground">Loading view…</p>;
  return (
    <PreviewSection
      workspace={workspace}
      paneId={subshellId}
      access={subshell.access}
      subshell={subshell}
      preview={preview}
      fill
      initialView={choice}
      onClose={onClose}
    />
  );
}
