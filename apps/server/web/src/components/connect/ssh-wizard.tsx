import { Button } from "@internal/node-admin";
import { useEffect, useState } from "react";
import { SshDestinationStep } from "@/components/connect/ssh-destination-step";
import { SshKeyStep } from "@/components/connect/ssh-key-step";
import { SshMachineSetup, SshMachineStep } from "@/components/connect/ssh-machine-step";
import {
  type SshSessionDraft,
  sshDestination,
  sshKeySelectionProblem,
  sshKeySourceProblem,
} from "@/components/connect/ssh-session-draft";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useSshNodeRoster } from "@/hooks/use-ssh";
import { makeForm, useSubmitDisabled } from "@/lib/form";
import { type SshMachineReadiness, sshCanEnableOnStart } from "@/lib/ssh";

export interface SshWizardProps {
  /** Shared with the connection form and retained by the outer dialog. */
  draft: SshSessionDraft;
  /** Writes canonical choices, including an explicitly empty key selection. */
  onDraftChange: (draft: SshSessionDraft) => void;
  /** Readiness is supplied by the mounted content host. */
  machines: SshMachineReadiness[];
  /** Retrying never discards the draft. */
  readiness: { isPending: boolean; isError: boolean; refetch: () => unknown };
  /** Actual launch only; setup completion never invokes it. */
  onStart: () => Promise<void>;
  /** Return to the prior form without undoing completed machine changes. */
  onCancel: () => void;
  /** Close before leaving for authorized machine settings. */
  onLeave?: () => void;
  /** Includes the parent's asynchronous workspace/split attachment. */
  busy: boolean;
  /** A pane already exists; attachment failure must not create a second one. */
  launchBlocked?: boolean;
}

export function SshWizard({
  draft,
  onDraftChange,
  machines,
  readiness,
  onStart,
  onCancel,
  onLeave,
  busy,
  launchBlocked,
}: SshWizardProps) {
  const [useRemote, setUseRemote] = useState(!!draft.keyHome);
  const machine = machines.find((item) => item.node.id === draft.nodeId);
  const keyMachine = machines.find((item) => item.node.id === draft.keyHome);
  const remote = useRemote;
  const keyMachines = machines.filter((item) => item.node.canLaunch);
  const noOtherKeyNodes =
    !readiness.isPending && !readiness.isError && !keyMachines.some((item) => item.node.id !== draft.nodeId);
  const keyProblem = remote ? sshKeySourceProblem(draft) : null;
  const fingerprints = draft.selections[draft.keyHome] ?? [];
  const roster = useSshNodeRoster(remote && !keyProblem && keyMachine?.canConnect ? draft.keyHome : null);
  const patch = (value: Partial<SshSessionDraft>) => onDraftChange({ ...draft, ...value });
  const problems = (): Record<string, string> => {
    if (!draft.nodeId) return { draft: "Choose a node." };
    if (!sshDestination(draft)) return { draft: "Enter an SSH destination." };
    if (remote) {
      const error = !draft.keyHome
        ? "Choose a node to supply keys."
        : keyProblem || sshKeySelectionProblem(fingerprints);
      if (error) return { draft: error };
    }
    return {};
  };
  const enableOnStart = sshCanEnableOnStart(machine);
  const blocked =
    busy ||
    readiness.isPending ||
    readiness.isError ||
    (!machine?.canConnect && !enableOnStart) ||
    !!launchBlocked ||
    (remote &&
      (!keyMachine?.canConnect ||
        roster.isPending ||
        roster.isError ||
        sshKeySelectionProblem(fingerprints, roster.data?.identities) !== null));
  const form = makeForm({
    defaultValues: { draft, remote },
    validator: problems,
    onSubmit: async () => {
      if (blocked || Object.keys(problems()).length) return;
      await onStart();
    },
  });
  useEffect(() => {
    form.setFieldValue("draft", draft);
    form.setFieldValue("remote", remote);
    void form.validate("change");
  }, [draft, remote, form]);
  const disabled = useSubmitDisabled(form, blocked);
  return (
    <section className="flex flex-col gap-4" aria-label="SSH setup">
      <FieldGroup>
        <SshQueryStatus query={readiness} label="connecting machines" />
        <SshMachineStep
          machines={machines}
          value={draft.nodeId}
          onChange={(nodeId) => patch({ nodeId })}
          label="Connect from"
          description="Choose the node that will make the SSH connection."
          notice={enableOnStart ? "Starting this subshell will enable outgoing SSH on this node." : undefined}
        />
        {!enableOnStart && machine && !machine.canConnect ? (
          <SshMachineSetup
            showName={false}
            allowEnable={false}
            machine={machine}
            retry={readiness.refetch}
            onLeave={onLeave}
          />
        ) : null}
        <SshDestinationStep
          draft={draft}
          onChange={onDraftChange}
          nodeName={machine?.node.name}
          ready={machine?.canConnect ?? false}
        />
        <RadioGroup
          aria-label="SSH keys"
          value={useRemote ? "remote" : "connecting"}
          onValueChange={(value) => {
            setUseRemote(value === "remote");
            if (value === "connecting") patch({ keyHome: "" });
          }}
        >
          <Field className="flex-row items-start gap-3">
            <RadioGroupItem
              id="ssh-keys-connecting"
              value="connecting"
              aria-labelledby="ssh-keys-connecting-label"
              aria-describedby="ssh-keys-node-name"
            />
            <FieldLabel htmlFor="ssh-keys-connecting" className="flex min-w-0 cursor-pointer flex-col gap-1">
              <span id="ssh-keys-connecting-label">Use the connecting node’s keys</span>
              <span id="ssh-keys-node-name" className="break-all text-detail text-muted-foreground">
                {machine?.node.name ?? "Choose a connecting node"}
              </span>
            </FieldLabel>
          </Field>
          <Field className="flex-row items-center gap-3">
            <RadioGroupItem id="ssh-keys-remote" value="remote" />
            <FieldLabel htmlFor="ssh-keys-remote">Use another node’s keys</FieldLabel>
          </Field>
        </RadioGroup>
        {remote && (
          <FieldGroup>
            {noOtherKeyNodes ? (
              <p role="status" className="text-detail text-muted-foreground">
                No other nodes are available to supply keys. Use the connecting node’s keys or add another node.
              </p>
            ) : (
              <SshMachineStep
                machines={keyMachines}
                value={draft.keyHome}
                onChange={(keyHome) => {
                  setUseRemote(true);
                  patch({ keyHome });
                }}
                exclude={draft.nodeId}
                id="ssh-keys-machine"
                label="Use keys from"
              />
            )}
            {keyProblem && (
              <p role="alert" className="text-destructive text-detail">
                {keyProblem}
              </p>
            )}
            {keyMachine && !keyProblem && !keyMachine.canConnect && (
              <SshMachineSetup showName={false} machine={keyMachine} retry={readiness.refetch} onLeave={onLeave} />
            )}
            {keyMachine?.canConnect && !keyProblem && (
              <SshKeyStep
                nodeId={draft.keyHome}
                fingerprints={fingerprints}
                onChange={(selection) => patch({ selections: { ...draft.selections, [draft.keyHome]: selection } })}
              />
            )}
          </FieldGroup>
        )}
        <Field className="flex-row items-center gap-3">
          <input
            id="ssh-remember"
            type="checkbox"
            checked={draft.remember}
            onChange={(event) => patch({ remember: event.target.checked })}
          />
          <FieldLabel htmlFor="ssh-remember">Remember this destination</FieldLabel>
        </Field>
        <p className="text-detail text-muted-foreground">
          Connecting uses this machine’s SSH configuration, including any local commands configured with Match exec.
        </p>
      </FieldGroup>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={disabled} onClick={() => void form.handleSubmit()}>
          {busy ? "Starting SSH subshell…" : "Start SSH subshell"}
        </Button>
      </div>
    </section>
  );
}
