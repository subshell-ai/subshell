import { Button, errMessage } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { SearchableSelect } from "@/components/ui/combobox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useEnableSsh } from "@/hooks/use-ssh";
import type { SshMachineReadiness } from "@/lib/ssh";

/** Lists visible machines even when they need preparation; launch and configuration are distinct rights. */
export function SshMachineStep({
  machines,
  value,
  onChange,
  label,
  exclude,
}: {
  machines: SshMachineReadiness[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  exclude?: string;
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="ssh-wizard-machine">{label}</FieldLabel>
        <SearchableSelect
          id="ssh-wizard-machine"
          value={value}
          placeholder="Choose a machine"
          options={machines
            .filter((m) => m.node.id !== exclude || m.node.id === value)
            .map((m) => ({
              value: m.node.id,
              label: m.node.name,
              disabled: m.node.id === exclude,
              reason:
                m.node.id === exclude ? "Choose a different key machine." : m.blockers.map((b) => b.message).join(" "),
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
}: {
  machine?: SshMachineReadiness;
  retry: () => unknown;
  onLeave?: () => void;
}) {
  const enable = useEnableSsh();
  const navigate = useNavigate();
  if (!machine)
    return (
      <p role="alert" className="text-destructive text-detail">
        The selected machine is no longer available to you. Go Back and choose another machine.
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
      <p className="font-strong text-body">{machine.node.name}</p>
      {machine.canConnect ? (
        <p role="status" className="text-detail">
          Ready to run SSH. Authentication to a destination has not been tested.
        </p>
      ) : (
        <>
          {machine.blockers.map((blocker) => (
            <p key={`${blocker.code}:${blocker.message}`} className="text-detail text-muted-foreground">
              {blocker.message}
            </p>
          ))}
          {!machine.node.sshEnabled &&
            (machine.canConfigure ? (
              <Button
                type="button"
                className="self-start"
                disabled={enable.isPending}
                onClick={() => enable.mutate(machine.node.id)}
              >
                {enable.isPending ? "Enabling SSH…" : "Enable SSH"}
              </Button>
            ) : (
              <p className="text-detail text-muted-foreground">
                {machine.node.kind === "local" ? "An admin" : "This machine’s owner"} can enable SSH. Launch access does
                not allow changing its configuration.
              </p>
            ))}
          {!onlyNeedsEnable && (
            <Button type="button" variant="outline" className="self-start" onClick={() => void retry()}>
              Retry machine status
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
          {errMessage(enable.error, "SSH could not be enabled. Retry when the machine is available.")}
        </p>
      )}
    </div>
  );
}
