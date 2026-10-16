import { Button } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { SearchableSelect } from "@/components/ui/combobox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { type SshMachineReadiness, sshMachineRowReason } from "@/lib/ssh";

/** Lists visible machines even when they need preparation; launch and configuration are distinct rights. */
export function SshMachineStep({
  machines,
  value,
  onChange,
  label,
  hideLabel = false,
  description,
  notice,
  children,
  exclude,
  id = "ssh-wizard-machine",
}: {
  machines: SshMachineReadiness[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  hideLabel?: boolean;
  description?: string;
  notice?: string;
  children?: ReactNode;
  exclude?: string;
  id?: string;
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
          {label}
        </FieldLabel>
        <SearchableSelect
          id={id}
          value={value}
          placeholder="Choose a node"
          options={machines
            .filter((m) => m.node.id !== exclude || m.node.id === value)
            .map((m) => {
              const row = sshMachineRowReason(m);
              return {
                value: m.node.id,
                label: m.node.name,
                disabled: m.node.id === exclude,
                reason: m.node.id === exclude ? "Choose a different machine to supply your keys." : row?.reason,
                reasonWarning: m.node.id !== exclude && row?.warning === true,
              };
            })}
          onValueChange={(id) => id && onChange(id)}
        />
        {description && <p className="text-detail text-muted-foreground">{description}</p>}
        {notice && <p className="text-detail text-warning">{notice}</p>}
        {children}
        {value && !machines.some((m) => m.node.id === value) && (
          <p role="alert" className="text-destructive text-detail">
            The selected machine is no longer available to you. Choose another machine.
          </p>
        )}
      </Field>
    </FieldGroup>
  );
}

/** Readiness guidance stays beside its picker while the parent polls for changes. */
export function SshMachineSetup({
  machine,
  onLeave,
  showName = true,
  polling = true,
}: {
  machine?: SshMachineReadiness;
  showName?: boolean;
  polling?: boolean;
  onLeave?: () => void;
}) {
  const navigate = useNavigate();
  if (!machine)
    return (
      <p role="alert" className="text-destructive text-detail">
        The selected machine is no longer available to you. Go back and choose another machine.
      </p>
    );
  const needsSettings =
    machine.blockers.some(
      (blocker) => blocker.code === "NODE_IN_MAINTENANCE" || blocker.code === "NODE_PROTOCOL_HELD",
    ) ||
    (machine.node.kind === "agent" && !machine.node.canLaunch);
  return (
    <div className="flex flex-col gap-2">
      {showName && <p className="font-strong text-body">{machine.node.name}</p>}
      {machine.canConnect ? (
        <p role="status" className="text-detail">
          Outgoing SSH is enabled on this node. You can try connecting to your destination.
        </p>
      ) : (
        <>
          <p className="text-detail text-warning">
            {machine.blockers.map((blocker) => blocker.message).join(" ")}
            {!machine.node.sshEnabled && !machine.canConfigure && (
              <>
                {" "}
                {machine.node.kind === "local"
                  ? "Ask an admin to enable it."
                  : machine.ownerLabel
                    ? `Ask this node’s owner (${machine.ownerLabel}) to enable it.`
                    : "Ask this node’s owner to enable it."}
              </>
            )}
          </p>
          {!machine.node.sshEnabled && !machine.canConfigure && polling && (
            <p role="status" className="flex items-center gap-2 text-detail text-warning">
              <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
              Waiting for SSH to be enabled…
            </p>
          )}
          {machine.canConfigure && needsSettings && (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => {
                onLeave?.();
                void navigate({ to: "/nodes/$id", params: { id: machine.node.id } });
              }}
            >
              Open {machine.node.name} settings
            </Button>
          )}
        </>
      )}
    </div>
  );
}
