import { useId, useState } from "react";
import { NodeUnavailableNote } from "@/components/preview/node-unavailable-note";
import { nodeReasonLine, PortList } from "@/components/preview/port-list";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { requestWorkspacePreview, type WorkspacePreviewTarget } from "@/lib/workspace-preview";
import { PreviewSettingsDialog } from "./preview-settings-dialog";
import { SavedServices } from "./saved-services";

export function PreviewChooserDialog({ subshellId, onClose }: { subshellId: string; onClose: () => void }) {
  const configureId = useId();
  const subshell = useSubshellRow(subshellId);
  const preview = useSubshellPreview(subshellId, subshell);
  const info = preview.info;
  const [configure, setConfigure] = useState(false);
  const [target, setTarget] = useState<Extract<WorkspacePreviewTarget, { kind: "app" | "service" }> | null>(null);
  function open(view: WorkspacePreviewTarget) {
    if (configure && (view.kind === "app" || view.kind === "service")) setTarget(view);
    else if (requestWorkspacePreview(subshellId, view)) onClose();
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
          <DialogTitle>Open web preview or screen</DialogTitle>
        </DialogHeader>
        {subshell && subshell.access !== "view" && (
          <Field>
            <div className="flex items-center gap-2">
              <Checkbox id={configureId} checked={configure} onCheckedChange={setConfigure} />
              <FieldLabel htmlFor={configureId}>Configure preview before opening</FieldLabel>
            </div>
          </Field>
        )}
        {target && (
          <PreviewSettingsDialog
            paneId={subshellId}
            port={target.port}
            serviceId={target.kind === "service" ? target.serviceId : undefined}
            onClose={() => setTarget(null)}
            onOpen={() => {
              if (requestWorkspacePreview(subshellId, target)) onClose();
            }}
          />
        )}
        {!info && !preview.error && <p className="text-detail text-muted-foreground">Checking available views…</p>}
        {preview.error && (
          <p role="alert" className="text-destructive text-detail">
            {preview.error}
          </p>
        )}
        {info && (!info.nodeEnabled || info.reason) && <NodeUnavailableNote info={info} />}
        {info && subshell && (
          <PortList
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
                  : !info?.nodeEnabled || info.webPreviewsEnabled === false
                    ? info
                      ? nodeReasonLine(info.webPreviewsEnabled === false ? "web-previews-disabled" : info.reason)
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
