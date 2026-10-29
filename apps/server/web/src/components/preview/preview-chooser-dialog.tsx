import { useState } from "react";
import { NodeUnavailableNote } from "@/components/preview/node-unavailable-note";
import { nodeReasonLine, PortList } from "@/components/preview/port-list";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import type { SavedService } from "@/hooks/use-subshell-services";
import { requestWorkspacePreview, type WorkspacePreviewTarget } from "@/lib/workspace-preview";
import { PreviewConfigurationForm } from "./preview-configuration-form";
import { SavedServices } from "./saved-services";

export function PreviewChooserDialog({ subshellId, onClose }: { subshellId: string; onClose: () => void }) {
  const subshell = useSubshellRow(subshellId);
  const preview = useSubshellPreview(subshellId, subshell);
  const info = preview.info;
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<{
    mode: "open" | "create" | "edit";
    port?: number;
    service?: SavedService;
  } | null>(null);
  function open(view: WorkspacePreviewTarget) {
    if (requestWorkspacePreview(subshellId, view)) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {target
              ? target.mode === "edit"
                ? "Edit service"
                : target.mode === "create"
                  ? "Add service"
                  : "Configure preview"
              : "Open web preview or screen"}
          </DialogTitle>
        </DialogHeader>
        {target ? (
          <PreviewConfigurationForm
            key={`${target.mode}-${target.service?.id ?? target.port ?? "new"}`}
            subshellId={subshellId}
            port={target.port}
            service={target.service}
            mode={target.mode}
            onBack={() => setTarget(null)}
            onSaved={() => setTarget(null)}
            onOpen={open}
            onBusyChange={setBusy}
          />
        ) : (
          <>
            {!info && !preview.error && <p className="text-detail text-muted-foreground">Checking available views…</p>}
            {preview.error && (
              <p role="alert" className="text-destructive text-detail">
                {preview.error}
              </p>
            )}
            {info && <NodeUnavailableNote info={info} />}
            {info && subshell && (
              <PortList
                info={info}
                access={subshell.access}
                watching={false}
                onOpen={(port) => setTarget({ mode: "open", port })}
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
                onAdd={() => setTarget({ mode: "create" })}
                onEdit={(service) => setTarget({ mode: "edit", service })}
                onOpen={(service) => {
                  if (service.configuration?.sandbox === false) setTarget({ mode: "open", service });
                  else open({ kind: "service", serviceId: service.id, port: service.port, revision: service.revision });
                }}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
