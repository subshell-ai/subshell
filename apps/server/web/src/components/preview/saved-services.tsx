import { Button, errMessage, Input } from "@internal/node-admin";
import { normalizeServiceHost, serviceAuthority } from "@internal/subshell-protocol";
import { Globe, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSubshellServices } from "@/hooks/use-subshell-services";
import type { WorkspacePreviewTarget } from "@/lib/workspace-preview";

export function SavedServices({
  subshellId,
  canEdit,
  openReason,
  onOpen,
}: {
  subshellId: string;
  canEdit: boolean;
  openReason?: string;
  onOpen: (target: WorkspacePreviewTarget) => void;
}) {
  const services = useSubshellServices(subshellId);
  const [adding, setAdding] = useState(false);
  const portInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) portInput.current?.focus();
  }, [adding]);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState<"http" | "https">("http");
  const [host, setHost] = useState("localhost");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const rows = services.data ?? [];
  const portNumber = Number(port);
  const invalid =
    !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535
      ? "Enter a port between 1 and 65535."
      : !normalizeServiceHost(host)
        ? "Enter a hostname or IP address."
        : undefined;
  const editReason = !canEdit
    ? "Managing saved services needs edit access to this subshell."
    : busy
      ? "Saving your changes…"
      : undefined;
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-strong text-label">Saved services</span>
        {!adding && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!editReason}
            disabledReason={editReason}
            onClick={() => setAdding(!adding)}
            aria-expanded={adding}
          >
            <Plus data-icon="inline-start" />
            Add service
          </Button>
        )}
      </div>
      {(error || services.error) && (
        <p role="alert" className="text-destructive text-detail">
          {error ?? errMessage(services.error, "Couldn't load saved services.")}
        </p>
      )}
      {adding && (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (invalid || editReason) return;
            setBusy(true);
            setError(null);
            try {
              await services.save({ name, host, port: portNumber, protocol });
              setAdding(false);
              setName("");
              setPort("");
            } catch (err) {
              setError(errMessage(err, "Couldn't save this service."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-detail text-muted-foreground">
            Connect to a web service on this subshell's node. A virtual display isn't required.
          </p>
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor={`${id}-port`}>Port</FieldLabel>
              <Input
                ref={portInput}
                id={`${id}-port`}
                type="number"
                min={1}
                max={65535}
                required
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="3000"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-protocol`}>Protocol</FieldLabel>
              <Select
                value={protocol}
                items={[
                  { value: "http", label: "HTTP" },
                  { value: "https", label: "HTTPS" },
                ]}
                onValueChange={(value) => {
                  if (value === "http" || value === "https") setProtocol(value);
                }}
              >
                <SelectTrigger id={`${id}-protocol`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="https">HTTPS</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name (optional)</FieldLabel>
              <Input
                id={`${id}-name`}
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My website"
              />
            </Field>
            <details>
              <summary className="cursor-pointer text-label">Advanced</summary>
              <Field className="pt-3">
                <FieldLabel htmlFor={`${id}-host`}>Host</FieldLabel>
                <Input id={`${id}-host`} maxLength={253} value={host} onChange={(e) => setHost(e.target.value)} />
                <p className="text-detail text-muted-foreground">
                  localhost means the subshell's node. Another host can reach private or link-local services from that
                  node. Only save destinations you trust people with edit access to use.
                </p>
              </Field>
            </details>
          </FieldGroup>
          {protocol === "https" && (
            <p className="text-detail text-muted-foreground">The node must trust the service's HTTPS certificate.</p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={!!(editReason || invalid)} disabledReason={editReason || invalid}>
              Save service
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
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
                onClick={() => onOpen({ kind: "service", serviceId: row.id, port: row.port })}
              >
                <Globe data-icon="inline-start" />
                <span className="min-w-0 truncate">
                  {row.name || `App · ${row.port}`}
                  <span className="ml-2 text-detail text-muted-foreground">
                    {row.protocol}://{serviceAuthority(row.host, row.port)}
                  </span>
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${row.name || `port ${row.port}`}`}
                title="Remove saved connection; leave the service running"
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
      {!rows.length && !adding && !services.isPending && (
        <p className="text-detail text-muted-foreground">
          Add services started outside this subshell. Saved connections stay here when you close their tabs.
        </p>
      )}
    </div>
  );
}
