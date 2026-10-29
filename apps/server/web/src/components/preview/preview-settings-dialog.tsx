import type { PreviewConfiguration } from "@internal/subshell-protocol";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSubshellServices } from "@/hooks/use-subshell-services";
import type { WorkspacePreviewTarget } from "@/lib/workspace-preview";
import { PreviewConfigurationForm } from "./preview-configuration-form";

export function PreviewSettingsDialog({
  paneId,
  port,
  serviceId,
  configuration,
  onClose,
  onOpen,
}: {
  paneId: string;
  port: number;
  serviceId?: string;
  configuration?: PreviewConfiguration;
  onClose: () => void;
  onOpen: (view: WorkspacePreviewTarget) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const services = useSubshellServices(paneId, !!serviceId);
  const service = services.data?.find((row) => row.id === serviceId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure preview</DialogTitle>
        </DialogHeader>
        {serviceId && !service ? (
          <p role="status">
            {services.isPending
              ? "Loading saved service…"
              : "This saved service is unavailable. Close this view and choose another service."}
          </p>
        ) : (
          <PreviewConfigurationForm
            subshellId={paneId}
            port={port}
            service={service}
            configuration={service ? undefined : configuration}
            onBusyChange={setBusy}
            mode={service ? "edit" : "open"}
            onBack={onClose}
            onSaved={async (saved) => {
              await onOpen({
                kind: "service",
                serviceId: saved.id,
                port: saved.port,
                revision: saved.revision,
                configuration: saved.configuration ?? undefined,
              });
              onClose();
            }}
            onOpen={async (view) => {
              await onOpen(view);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
