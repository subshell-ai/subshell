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
  const enableKeysOnStart = remote && sshCanEnableOnStart(keyMachine);
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
      const error = !draft.keyHome ? "Choose a node to supply keys." : keyProblem;
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
      !enableKeysOnStart &&
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
        >
          {!enableOnStart && machine && !machine.canConnect ? (
            <SshMachineSetup showName={false} machine={machine} polling={!readiness.isError} onLeave={onLeave} />
          ) : null}
        </SshMachineStep>
        <SshDestinationStep
          draft={draft}
          onChange={onDraftChange}
          nodeName={machine?.node.name}
          ready={machine?.canConnect ?? false}
        />
        <RadioGroup
          aria-label="SSH keys"
          value={draft.authentication === "password" ? "password" : useRemote ? "remote" : "connecting"}
          onValueChange={(value) => {
            setUseRemote(value === "remote");
            patch({
              authentication: value === "password" ? "password" : undefined,
              ...(value !== "remote" ? { keyHome: "" } : {}),
            });
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
              <span
                id="ssh-keys-node-name"
                className={machine ? "break-all text-detail text-muted-foreground" : "text-detail text-warning"}
              >
                {machine?.node.name ?? "Choose a node to connect from first"}
              </span>
            </FieldLabel>
          </Field>
          <Field className="flex-row items-start gap-3">
            <RadioGroupItem
              id="ssh-keys-remote"
              value="remote"
              aria-labelledby="ssh-keys-remote-label"
              aria-describedby={remote && noOtherKeyNodes ? "ssh-keys-empty" : undefined}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel htmlFor="ssh-keys-remote" className="cursor-pointer">
                <span id="ssh-keys-remote-label">Use another node’s keys</span>
              </FieldLabel>
              {remote && noOtherKeyNodes && (
                <span id="ssh-keys-empty" role="status" className="text-detail text-warning">
                  <label htmlFor="ssh-keys-remote" className="cursor-pointer">
                    No other nodes are available to supply keys. Use the connecting node’s keys or{" "}
                  </label>
                  <a
                    href="/nodes"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    aria-label="Add another node (opens in a new tab)"
                  >
                    add another node
                  </a>
                  .
                </span>
              )}
            </div>
          </Field>
          <Field className="flex-row items-start gap-3">
            <RadioGroupItem
              id="ssh-auth-password"
              value="password"
              aria-labelledby="ssh-auth-password-label"
              aria-describedby="ssh-auth-password-description"
            />
            <FieldLabel htmlFor="ssh-auth-password" className="flex min-w-0 cursor-pointer flex-col gap-1">
              <span id="ssh-auth-password-label">Enter a password when connecting</span>
              <span id="ssh-auth-password-description" className="text-detail text-muted-foreground">
                Enter your password in the terminal when SSH asks for it. Subshell won’t save it.
              </span>
            </FieldLabel>
          </Field>
        </RadioGroup>
        {remote && (!noOtherKeyNodes || keyProblem || keyMachine) && (
          <FieldGroup>
            {!noOtherKeyNodes && (
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
                notice={
                  enableKeysOnStart
                    ? "Starting this subshell will enable SSH on the node supplying keys. You’ll then choose which keys to use before connecting."
                    : undefined
                }
              >
                {keyMachine && !keyProblem && !keyMachine.canConnect && !enableKeysOnStart && (
                  <SshMachineSetup
                    showName={false}
                    machine={keyMachine}
                    polling={!readiness.isError}
                    onLeave={onLeave}
                  />
                )}
              </SshMachineStep>
            )}
            {keyProblem && (
              <p role="alert" className="text-destructive text-detail">
                {keyProblem}
              </p>
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
