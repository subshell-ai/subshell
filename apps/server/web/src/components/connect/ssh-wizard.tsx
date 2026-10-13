import { Button } from "@internal/node-admin";
import { useEffect, useState } from "react";
import { SshDestinationStep } from "@/components/connect/ssh-destination-step";
import { SshKeyStep } from "@/components/connect/ssh-key-step";
import { SshMachineSetup, SshMachineStep } from "@/components/connect/ssh-machine-step";
import {
  type SshSessionDraft,
  type SshWizardIntent,
  sshDestination,
  sshKeySelectionProblem,
  sshKeySourceProblem,
} from "@/components/connect/ssh-session-draft";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useSshNodeRoster } from "@/hooks/use-ssh";
import { makeForm, useSubmitDisabled } from "@/lib/form";
import type { SshMachineReadiness } from "@/lib/ssh";

export interface SshWizardProps {
  /** Optional entry intent. Null opens the task choices. */
  intent?: SshWizardIntent;
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
  /** Setup-only completion. */
  onDone: () => void;
  /** Return to the prior form without undoing completed machine changes. */
  onCancel: () => void;
  /** Close before leaving for authorized machine settings. */
  onLeave?: () => void;
  /** Includes the parent's asynchronous workspace/split attachment. */
  busy: boolean;
  /** A pane already exists; attachment failure must not create a second one. */
  launchBlocked?: boolean;
}

const choices: { value: SshWizardIntent; label: string; description: string }[] = [
  {
    value: "connect",
    label: "Connect to a destination",
    description: "Start an SSH subshell. Choose your destination, the node to connect from, and which keys to use.",
  },
  {
    value: "prepare",
    label: "Enable SSH on a node",
    description:
      "Allow a node to make outgoing SSH connections through Subshell. This doesn't enable incoming SSH access.",
  },
];

/** Each task stays on one form; changing tasks preserves the shared connection draft. */
export function SshWizard({
  intent: initialIntent,
  draft,
  onDraftChange,
  machines,
  readiness,
  onStart,
  onDone,
  onCancel,
  onLeave,
  busy,
  launchBlocked,
}: SshWizardProps) {
  const [intent, setIntent] = useState<SshWizardIntent | null>(initialIntent ?? null);
  const [choice, setChoice] = useState<string>(initialIntent ?? "connect");
  const [useRemote, setUseRemote] = useState(!!draft.keyHome);
  const machine = machines.find((item) => item.node.id === draft.nodeId);
  const keyMachine = machines.find((item) => item.node.id === draft.keyHome);
  const remote = intent === "connect" && useRemote;
  const keyProblem = remote ? sshKeySourceProblem(draft) : null;
  const fingerprints = draft.selections[draft.keyHome] ?? [];
  const roster = useSshNodeRoster(remote && !keyProblem && keyMachine?.canConnect ? draft.keyHome : null);
  const patch = (value: Partial<SshSessionDraft>) => onDraftChange({ ...draft, ...value });
  const problems = (): Record<string, string> => {
    if (!intent) return {};
    if (!draft.nodeId) return { node: "Choose a node." };
    if (intent === "connect" && !sshDestination(draft)) return { destination: "Enter an SSH destination." };
    if (remote) {
      const error = !draft.keyHome
        ? "Choose a node to supply keys."
        : keyProblem || sshKeySelectionProblem(fingerprints);
      if (error) return { keys: error };
    }
    return {};
  };
  const blocked =
    busy ||
    (intent !== null &&
      (readiness.isPending ||
        readiness.isError ||
        !machine?.canConnect ||
        (intent === "connect" && !!launchBlocked) ||
        (remote &&
          (!keyMachine?.canConnect ||
            roster.isPending ||
            roster.isError ||
            sshKeySelectionProblem(fingerprints, roster.data?.identities) !== null))));
  const form = makeForm({
    defaultValues: { draft, intent, remote },
    validator: problems,
    onSubmit: async () => {
      if (blocked || Object.keys(problems()).length) return;
      if (!intent) {
        setIntent(choice as SshWizardIntent);
        return;
      }
      if (intent === "prepare") {
        onDone();
        return;
      }
      await onStart();
    },
  });
  useEffect(() => {
    form.setFieldValue("draft", draft);
    form.setFieldValue("intent", intent);
    form.setFieldValue("remote", remote);
    void form.validate("change");
  }, [draft, intent, remote, form]);
  const disabled = useSubmitDisabled(form, blocked);
  return (
    <section className="flex flex-col gap-4" aria-label="SSH setup">
      {!intent ? (
        <RadioGroup aria-label="SSH action" value={choice} onValueChange={setChoice}>
          {choices.map((item) => (
            <Field key={item.value} className="flex-row items-start gap-3">
              <RadioGroupItem
                id={`ssh-action-${item.value}`}
                value={item.value}
                aria-labelledby={`ssh-action-${item.value}-label`}
                aria-describedby={`ssh-action-${item.value}-description`}
              />
              <FieldLabel htmlFor={`ssh-action-${item.value}`} className="flex min-w-0 cursor-pointer flex-col gap-1">
                <span id={`ssh-action-${item.value}-label`}>{item.label}</span>
                <span id={`ssh-action-${item.value}-description`} className="text-detail text-muted-foreground">
                  {item.description}
                </span>
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      ) : (
        <FieldGroup>
          <SshQueryStatus query={readiness} label="connecting machines" />
          {intent === "connect" && (
            <SshDestinationStep
              draft={draft}
              onChange={onDraftChange}
              nodeName={machine?.node.name}
              ready={machine?.canConnect ?? false}
            />
          )}
          <SshMachineStep
            machines={machines}
            value={draft.nodeId}
            onChange={(nodeId) => patch({ nodeId })}
            label={intent === "prepare" ? "Node to set up" : "Connect from"}
          />
          {intent !== "prepare" && (
            <p className="text-detail text-muted-foreground">Choose the node that will make the SSH connection.</p>
          )}
          {machine && (intent === "prepare" || !machine.canConnect) && (
            <SshMachineSetup showName={false} machine={machine} retry={readiness.refetch} onLeave={onLeave} />
          )}
          {intent === "connect" && (
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
          )}
          {remote && (
            <FieldGroup>
              <SshMachineStep
                machines={machines.filter((item) => item.node.canLaunch)}
                value={draft.keyHome}
                onChange={(keyHome) => {
                  setUseRemote(true);
                  patch({ keyHome });
                }}
                exclude={draft.nodeId}
                id="ssh-keys-machine"
                label="Use keys from"
              />
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
          {intent === "connect" && (
            <>
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
                Connecting uses this machine’s SSH configuration, including any local commands configured with Match
                exec.
              </p>
            </>
          )}
        </FieldGroup>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {intent && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setIntent(null)}>
            Back
          </Button>
        )}
        <Button type="button" disabled={disabled} onClick={() => void form.handleSubmit()}>
          {busy
            ? "Starting SSH subshell…"
            : !intent
              ? "Continue"
              : intent === "connect"
                ? "Start SSH subshell"
                : "Done"}
        </Button>
      </div>
    </section>
  );
}
