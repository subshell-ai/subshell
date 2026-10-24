import { Button } from "@internal/node-admin";
import { useState } from "react";
import { PreviewSection } from "@/components/preview/preview-section";
import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { requestWorkspacePreview, useWorkspacePreviews } from "@/lib/workspace-preview";
import type { SubshellView } from "@/types/subshell";

/** Background tabs release their preview subscriptions without remounting the terminal. */
export function WorkspacePreview({ subshell, active }: { subshell: SubshellView; active: boolean }) {
  const [shown, setShown] = useState(false);
  const previews = useWorkspacePreviews();
  if (!active || previews.some((preview) => preview.subshellId === subshell.id)) return null;
  return shown ? (
    <ActivePreview subshell={subshell} onHide={() => setShown(false)} />
  ) : (
    <div className="shrink-0 border-border border-t bg-card px-3 py-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          if (!requestWorkspacePreview(subshell.id)) setShown(true);
        }}
        aria-expanded={false}
      >
        Preview
      </Button>
    </div>
  );
}

function ActivePreview({ subshell, onHide }: { subshell: SubshellView; onHide: () => void }) {
  const preview = useSubshellPreview(subshell.id, subshell);
  return (
    <PreviewSection
      paneId={subshell.id}
      access={subshell.access}
      subshell={subshell}
      preview={preview}
      onHide={onHide}
    />
  );
}
