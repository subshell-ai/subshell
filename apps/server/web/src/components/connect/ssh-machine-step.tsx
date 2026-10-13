import { Button, errMessage } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { SearchableSelect } from "@/components/ui/combobox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useSetSshEnabled } from "@/hooks/use-ssh";
import type { SshMachineReadiness } from "@/lib/ssh";

/** Lists visible machines even when they need preparation; launch and configuration are distinct rights. */
export function SshMachineStep({
  machines,
  value,
  onChange,
  label,
  exclude,
  id = "ssh-wizard-machine",
}: {
  machines: SshMachineReadiness[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  exclude?: string;
  id?: string;
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <SearchableSelect
          id={id}
          value={value}
          placeholder="Choose a machine"
          options={machines
            .filter((m) => m.node.id !== exclude || m.node.id === value)
            .map((m) => ({
              value: m.node.id,
              label: m.node.name,
              disabled: m.node.id === exclude,
              reason:
                m.node.id === exclude
                  ? "Choose a different machine to supply your keys."
                  : m.blockers.map((b) => b.message).join(" "),
            }))}
          onValueChange={(id) => id && onChange(id)}
        />
        {value && !machines.some((m) => m.node.id === value) && (
          <p role="alert" className="text-destructive text-detail">
            The selected machine is no longer available to you. Choose another machine.
          </p>
        )}
      </Field>
    </FieldGroup>
  );
}

/** Explicitly enables SSH only where the readiness response authorizes configuration. */
export function SshMachineSetup({
  machine,
  retry,
  onLeave,
  showName = true,
}: {
  machine?: SshMachineReadiness;
  retry: () => unknown;
  showName?: boolean;
  onLeave?: () => void;
}) {
  const enable = useSetSshEnabled();
  const navigate = useNavigate();
  if (!machine)
    return (
      <p role="alert" className="text-destructive text-detail">
        The selected machine is no longer available to you. Go back and choose another machine.
      </p>
    );
  const onlyNeedsEnable =
    !machine.node.sshEnabled &&
    machine.canConfigure &&
    machine.blockers.length === 1 &&
    machine.blockers[0].code === "SSH_GATE_OFF";
  const needsSettings =
    machine.blockers.some(
      (blocker) => blocker.code === "NODE_IN_MAINTENANCE" || blocker.code === "NODE_PROTOCOL_HELD",
    ) ||
    (machine.node.kind === "agent" && !machine.node.canLaunch);
  return (
    <div className="flex flex-col gap-3">
      {showName && <p className="font-strong text-body">{machine.node.name}</p>}
      {machine.canConnect ? (
        <p role="status" className="text-detail">
          Outgoing SSH is enabled on this node. You can try connecting to your destination.
        </p>
      ) : (
        <>
          {machine.blockers.map((blocker) => (
            <p key={`${blocker.code}:${blocker.message}`} className="text-detail text-warning">
              {blocker.message}
            </p>
          ))}
          {!machine.node.sshEnabled &&
            (machine.canConfigure ? (
              <Button
                type="button"
                className="self-start"
                disabled={enable.isPending}
                onClick={() => enable.mutate({ id: machine.node.id, on: true })}
              >
                {enable.isPending ? "Enabling SSH…" : "Enable SSH"}
              </Button>
            ) : (
              <p className="text-detail text-muted-foreground">
                {machine.node.kind === "local" ? "Ask an admin to enable it." : "Ask this node’s owner to enable it."}
              </p>
            ))}
          {!onlyNeedsEnable && (
            <Button type="button" variant="outline" className="self-start" onClick={() => void retry()}>
              Check again
            </Button>
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
      {enable.isError && (
        <p role="alert" className="text-destructive text-detail">
          {errMessage(enable.error, "Couldn't enable SSH. Try again when the machine is available.")}
        </p>
      )}
    </div>
  );
}
