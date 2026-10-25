import { nodeReasonLine, PortList } from "@/components/preview/port-list";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { requestWorkspacePreview, type WorkspacePreviewTarget } from "@/lib/workspace-preview";
import { SavedServices } from "./saved-services";

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
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Open app or screen</DialogTitle>
        </DialogHeader>
        {!info && !preview.error && <p className="text-detail text-muted-foreground">Checking available views…</p>}
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
          <p className="text-detail text-muted-foreground">No apps or screens discovered in this subshell.</p>
        )}
        {subshell && (
          <SavedServices
            subshellId={subshellId}
            canEdit={subshell.access !== "view"}
            openReason={
              subshell.access === "view"
                ? "Opening a service needs edit access to this subshell."
                : subshell.status !== "running" || !subshell.alive
                  ? "Restart this subshell to open its saved services."
                  : !info?.nodeEnabled || info.appsEnabled === false
                    ? info
                      ? nodeReasonLine(info.appsEnabled === false ? "apps-disabled" : info.reason)
                      : "Checking this node…"
                    : undefined
            }
            onOpen={open}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
