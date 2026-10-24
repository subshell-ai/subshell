import { nodeReasonLine, PortList } from "@/components/preview/port-list";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { requestWorkspacePreview, type WorkspacePreviewTarget } from "@/lib/workspace-preview";

export function PreviewChooserDialog({ subshellId, onClose }: { subshellId: string; onClose: () => void }) {
  const subshell = useSubshellRow(subshellId);
  const preview = useSubshellPreview(subshellId, subshell);
  const info = preview.info;
  function open(view: WorkspacePreviewTarget) {
    if (requestWorkspacePreview(subshellId, view)) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open preview</DialogTitle>
        </DialogHeader>
        {!info && <p className="text-detail text-muted-foreground">Checking available views…</p>}
        {preview.error && (
          <p role="alert" className="text-destructive text-detail">
            {preview.error}
          </p>
        )}
        {info && (!info.nodeEnabled || info.reason) && (
          <p className="text-detail text-muted-foreground">{nodeReasonLine(info.reason)}</p>
        )}
        {info && subshell && (
          <PortList
            compact
            info={info}
            access={subshell.access}
            watching={false}
            onOpen={(port) => open({ kind: "app", port })}
            onScreen={() => open({ kind: "screen" })}
            onWatch={() => open({ kind: "browser" })}
          />
        )}
        {info?.nodeEnabled && !info.reason && !info.ports.length && !info.screen && !info.cdpPort && (
          <p className="text-detail text-muted-foreground">
            Nothing to preview yet. Start an app in this subshell to see it here.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
