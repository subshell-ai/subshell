import { Button } from "@internal/node-admin";
import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BrowserKeyFields, type BrowserKeySelection } from "@/components/connect/browser-key-fields";
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
import { isDesktop } from "@/lib/desktop";
import { makeForm, useSubmitDisabled } from "@/lib/form";
import { type SshMachineReadiness, sshCanEnableOnStart } from "@/lib/ssh";

export interface SshWizardProps {
  /** Shared with the connection form and retained by the outer dialog. */
  draft: SshSessionDraft;
  browserKey: BrowserKeySelection;
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
  refusal?: string;
}

export function SshWizard({
  draft,
  browserKey,
  onDraftChange,
  machines,
  readiness,
  onStart,
  onCancel,
  onLeave,
  busy,
  launchBlocked,
  refusal,
}: SshWizardProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refusal) errorRef.current?.focus();
  }, [refusal]);
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
    if (draft.authentication === "local-key" && !isDesktop()) {
      const problem = browserKey.problem();
      if (problem) return { draft: problem };
    }
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
    defaultValues: { draft, remote, keyName: browserKey.name, trusted: browserKey.trusted },
    validator: problems,
    onSubmit: async () => {
      if (blocked || Object.keys(problems()).length) return;
      await onStart();
    },
  });
  useEffect(() => {
    form.setFieldValue("draft", draft);
    form.setFieldValue("remote", remote);
    form.setFieldValue("keyName", browserKey.name);
    form.setFieldValue("trusted", browserKey.trusted);
    void form.validate("change");
  }, [draft, remote, form, browserKey.name, browserKey.trusted]);
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
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend id="ssh-authentication-heading" className="mb-2 font-strong text-label">
            Authentication
          </legend>
          <RadioGroup
            aria-labelledby="ssh-authentication-heading"
            value={draft.authentication ?? (useRemote ? "remote" : "connecting")}
            onValueChange={(value) => {
              setUseRemote(value === "remote");
              patch({
                authentication: value === "password" || value === "local-key" ? value : undefined,
                ...(value !== "remote" ? { keyHome: "" } : {}),
              });
            }}
          >
            <Field className="flex-row items-start gap-3">
              <RadioGroupItem
                id="ssh-keys-connecting"
                value="connecting"
                aria-labelledby="ssh-keys-connecting-label"
                aria-describedby={!draft.authentication && !remote ? "ssh-keys-node-name" : undefined}
              />
              <FieldLabel htmlFor="ssh-keys-connecting" className="flex min-w-0 cursor-pointer flex-col gap-1">
                <span id="ssh-keys-connecting-label">Use the connecting node’s keys</span>
                {!draft.authentication && !remote && (
                  <span
                    id="ssh-keys-node-name"
                    className={
                      machine
                        ? "break-all font-regular text-detail text-muted-foreground"
                        : "font-regular text-detail text-warning"
                    }
                  >
                    {machine?.node.name ?? "Choose a node to connect from first"}
                  </span>
                )}
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
                id="ssh-auth-local-key"
                value="local-key"
                aria-labelledby="ssh-auth-local-key-label"
                aria-describedby={
                  draft.authentication === "local-key"
                    ? isDesktop()
                      ? "ssh-auth-local-key-description"
                      : "ssh-browser-key-risk"
                    : undefined
                }
              />
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <FieldLabel htmlFor="ssh-auth-local-key" className="cursor-pointer">
                  <span id="ssh-auth-local-key-label">Use a key from my machine</span>
                </FieldLabel>
                {draft.authentication === "local-key" &&
                  (isDesktop() ? (
                    <p id="ssh-auth-local-key-description" className="font-regular text-detail text-muted-foreground">
                      Choose a key when you start. It stays on your machine and is released after one authentication
                      attempt or 90 seconds.
                    </p>
                  ) : (
                    <BrowserKeyFields selection={browserKey} busy={busy} />
                  ))}
              </div>
            </Field>
            <Field className="flex-row items-start gap-3">
              <RadioGroupItem
                id="ssh-auth-password"
                value="password"
                aria-labelledby="ssh-auth-password-label"
                aria-describedby={draft.authentication === "password" ? "ssh-auth-password-description" : undefined}
              />
              <FieldLabel htmlFor="ssh-auth-password" className="flex min-w-0 cursor-pointer flex-col gap-1">
                <span id="ssh-auth-password-label">Enter a password when connecting</span>
                {draft.authentication === "password" && (
                  <span id="ssh-auth-password-description" className="font-regular text-detail text-muted-foreground">
                    Enter your password in the terminal when SSH asks for it. Subshell won’t save it.
                  </span>
                )}
              </FieldLabel>
            </Field>
          </RadioGroup>
        </fieldset>
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
      </FieldGroup>
      {refusal && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="flex items-start gap-2">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-strong text-destructive text-detail">
              {launchBlocked ? "Connection needs attention" : "Connection failed"}
            </p>
            <p className="break-words text-detail text-muted-foreground">{refusal}</p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy && draft.authentication !== "local-key"}
          disabledReason="Wait for SSH startup to finish, or close the native key picker to cancel selection."
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={disabled}
          disabledReason={
            busy
              ? "SSH startup is in progress."
              : launchBlocked
                ? "This SSH subshell already exists. Open it from the subshell list."
                : (Object.values(problems())[0] ??
                  (readiness.isPending
                    ? "Checking which nodes can connect."
                    : readiness.isError
                      ? "Reload the connecting nodes before starting."
                      : !machine?.canConnect && !enableOnStart
                        ? "The connecting node isn't ready. Check the requirements above."
                        : remote
                          ? "Choose available SSH keys from a ready node."
                          : "Complete the connection details above."))
          }
          onClick={() => void form.handleSubmit()}
        >
          {busy ? "Starting SSH subshell…" : "Start SSH subshell"}
        </Button>
      </div>
    </section>
  );
}
