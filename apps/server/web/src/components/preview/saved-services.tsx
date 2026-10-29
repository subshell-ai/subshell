import { Button, errMessage, Input } from "@internal/node-admin";
import { serviceAuthority } from "@internal/subshell-protocol";
import { Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { type SavedService, useSubshellServices } from "@/hooks/use-subshell-services";

export function SavedServices({
  subshellId,
  canEdit,
  openReason,
  onOpen,
  onAdd,
  onEdit,
}: {
  subshellId: string;
  canEdit: boolean;
  openReason?: string;
  onOpen: (service: SavedService) => void;
  onAdd: () => void;
  onEdit: (service: SavedService) => void;
}) {
  const services = useSubshellServices(subshellId);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = services.data ?? [];
  const editReason = !canEdit
    ? "Managing saved services needs edit access to this subshell."
    : busy
      ? "Saving your changes…"
      : undefined;
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-strong text-label">Saved services</span>
        <Button size="sm" variant="outline" disabled={!!editReason} disabledReason={editReason} onClick={onAdd}>
          <Plus data-icon="inline-start" />
          Add service
        </Button>
      </div>
      {(error || services.error) && (
        <p role="alert" className="text-destructive text-detail">
          {error ?? errMessage(services.error, "Couldn't load saved services.")}
        </p>
      )}
      {rows.length > 6 && (
        <Input
          aria-label="Find saved services"
          placeholder="Find by name, host, or port…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {rows
          .filter((row) => `${row.name} ${row.host} ${row.port}`.toLowerCase().includes(search.toLowerCase()))
          .map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="min-w-0 flex-1 justify-start"
                disabled={!!openReason}
                disabledReason={openReason}
                onClick={() => onOpen(row)}
              >
                <Globe data-icon="inline-start" />
                <span className="min-w-0 truncate">
                  {row.name || `App · ${row.port}`}
                  <span className="ml-2 text-detail text-muted-foreground">
                    {row.protocol}://{serviceAuthority(row.host, row.port)}
                  </span>
                  {row.ignoreCertificateErrors && (
                    <span className="ml-2 text-detail text-warning">Certificate validation off</span>
                  )}
                  {row.configuration?.sandbox === false && (
                    <span className="ml-2 text-detail text-warning">Sandbox off</span>
                  )}
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${row.name || `port ${row.port}`}`}
                disabled={!!editReason}
                disabledReason={editReason}
                onClick={() => onEdit(row)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${row.name || `port ${row.port}`}`}
                disabled={!!editReason}
                disabledReason={editReason}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await services.remove(row.id);
                  } catch (err) {
                    setError(errMessage(err, "Couldn't remove this service."));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
      </div>
      {!rows.length && !services.isPending && (
        <p className="text-detail text-muted-foreground">
          Add services started outside this subshell. Saved connections stay here when you close their tabs.
        </p>
      )}
    </div>
  );
}
