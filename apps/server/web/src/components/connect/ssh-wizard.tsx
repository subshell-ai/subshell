import { Button } from "@internal/node-admin";
import { CircleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { BrowserKeyFields, type BrowserKeySelection } from "@/components/connect/browser-key-fields";
import { SshDestinationStep } from "@/components/connect/ssh-destination-step";
import { SshForwardFields } from "@/components/connect/ssh-forward-fields";
import { SshKeyStep } from "@/components/connect/ssh-key-step";
import { SshMachineSetup, SshMachineStep } from "@/components/connect/ssh-machine-step";
import { SaveSshPresetFields } from "@/components/connect/ssh-preset-controls";
import {
  type SshSessionDraft,
  sshDestination,
  sshKeySelectionProblem,
  sshKeySourceProblem,
} from "@/components/connect/ssh-session-draft";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { ChoiceFields } from "@/components/ui/choice-fields";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useSshNodeRoster } from "@/hooks/use-ssh";
import { isDesktop } from "@/lib/desktop";
import { makeForm, useSubmitDisabled } from "@/lib/form";
import { type SshMachineReadiness, sshCanEnableOnStart } from "@/lib/ssh";
import { sshForwardListProblems } from "@/lib/ssh-forwards";
import { sshDestinationProblem, sshPresetNameProblem } from "@/lib/ssh-input-validation";

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
  /** Names the act a refusal refers to, so the heading isn't always "Connection failed". */
  refusalTitle?: string;
  /** Saving choices does not select a local key, enable SSH, or launch. */
  presetEditor?: { name: string; unchangedDestination?: boolean };
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
  refusalTitle,
  presetEditor,
}: SshWizardProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refusal) errorRef.current?.focus();
  }, [refusal]);
  const useRemote = draft.authentication === "remote" || (!draft.authentication && !!draft.keyHome);
  const machine = machines.find((item) => item.node.id === draft.nodeId);
  const keyMachine = machines.find((item) => item.node.id === draft.keyHome);
  const remote = useRemote;
  const enableKeysOnStart = !presetEditor && remote && sshCanEnableOnStart(keyMachine);
  const keyMachines = machines.filter((item) => item.node.canLaunch);
  const noOtherKeyNodes =
    !readiness.isPending && !readiness.isError && !keyMachines.some((item) => item.node.id !== draft.nodeId);
  const keyProblem = remote ? sshKeySourceProblem(draft) : null;
  const fingerprints = draft.selections[draft.keyHome] ?? [];
  const roster = useSshNodeRoster(remote && !keyProblem && keyMachine?.canConnect ? draft.keyHome : null);
  const patch = (value: Partial<SshSessionDraft>) => onDraftChange({ ...draft, ...value });
  const problems = (values?: { draft: SshSessionDraft; presetName: string }): Record<string, string> => {
    const value = values?.draft ?? draft;
    const name = value.presetName ?? presetEditor?.name ?? "";
    const remote = value.authentication === "remote" || (!value.authentication && !!value.keyHome);
    const nameProblem = presetEditor || value.saveAsPreset ? sshPresetNameProblem(name) : null;
    if (nameProblem) return { draft: nameProblem };
    if (!presetEditor && value.authentication === "local-key" && !isDesktop()) {
      const problem = browserKey.problem();
      if (problem) return { draft: problem };
    }
    if (!value.nodeId) return { draft: "Choose a node." };
    const destinationProblem = sshDestinationProblem(sshDestination(value));
    if (destinationProblem) return { draft: destinationProblem };
    const forwardProblem = sshForwardListProblems(value.forwards);
    if (forwardProblem) return { draft: forwardProblem };
    if (remote) {
      const error = !value.keyHome ? "Choose a node to supply keys." : sshKeySourceProblem(value);
      if (error) return { draft: error };
      if (presetEditor) {
        const selectionError = sshKeySelectionProblem(value.selections[value.keyHome] ?? []);
        if (selectionError) return { draft: selectionError };
      }
    }
    return {};
  };
  const enableOnStart = !presetEditor && sshCanEnableOnStart(machine);
  const blocked =
    busy ||
    readiness.isPending ||
    readiness.isError ||
    (!!presetEditor && (!machine?.node.canLaunch || (remote && !keyMachine?.node.canLaunch))) ||
    (!machine?.canConnect && !enableOnStart && !presetEditor?.unchangedDestination) ||
    !!launchBlocked ||
    (!presetEditor &&
      remote &&
      !enableKeysOnStart &&
      (!keyMachine?.canConnect ||
        roster.isPending ||
        roster.isError ||
        sshKeySelectionProblem(fingerprints, roster.data?.identities) !== null));
  const form = makeForm({
    defaultValues: {
      draft,
      remote,
      presetName: presetEditor?.name ?? "",
      keyName: browserKey.name,
      trusted: browserKey.trusted,
    },
    validator: problems,
    onSubmit: async () => {
      if (blocked || Object.keys(problems()).length) return;
      await onStart();
    },
  });
  useEffect(() => {
    form.setFieldValue("draft", draft);
    form.setFieldValue("presetName", presetEditor?.name ?? "");
    form.setFieldValue("remote", remote);
    form.setFieldValue("keyName", browserKey.name);
    form.setFieldValue("trusted", browserKey.trusted);
    void form.validate("change");
  }, [draft, remote, form, browserKey.name, browserKey.trusted, presetEditor?.name]);
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
              patch({
                authentication: value as SshSessionDraft["authentication"],
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
                {
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
                }
              </FieldLabel>
            </Field>
            <Field className="flex-row items-start gap-3">
              <RadioGroupItem
                id="ssh-keys-remote"
                value="remote"
                aria-labelledby="ssh-keys-remote-label"
                aria-describedby="ssh-keys-remote-description"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <FieldLabel htmlFor="ssh-keys-remote" className="flex cursor-pointer flex-col gap-1">
                  <span id="ssh-keys-remote-label">Use another node’s keys</span>
                  <span id="ssh-keys-remote-description" className="font-regular text-detail text-muted-foreground">
                    Choose a different node to supply the keys for this connection.
                  </span>
                </FieldLabel>
                {remote && (
                  <ChoiceFields labelledBy="ssh-keys-remote-label">
                    {noOtherKeyNodes && (
                      <span id="ssh-keys-empty" role="status" className="text-detail text-warning">
                        No other nodes are available to supply keys. Use the connecting node’s keys or{" "}
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
                    {(!noOtherKeyNodes || keyProblem || keyMachine) && (
                      <FieldGroup>
                        {!noOtherKeyNodes && (
                          <SshMachineStep
                            machines={keyMachines}
                            value={draft.keyHome}
                            onChange={(keyHome) => {
                              patch({ keyHome, authentication: "remote" });
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
                            onChange={(selection) =>
                              patch({ selections: { ...draft.selections, [draft.keyHome]: selection } })
                            }
                          />
                        )}
                      </FieldGroup>
                    )}
                  </ChoiceFields>
                )}
              </div>
            </Field>
            <Field className="flex-row items-start gap-3">
              <RadioGroupItem
                id="ssh-auth-local-key"
                value="local-key"
                aria-labelledby="ssh-auth-local-key-label"
                aria-describedby="ssh-auth-local-key-summary"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <FieldLabel htmlFor="ssh-auth-local-key" className="flex cursor-pointer flex-col gap-1">
                  <span id="ssh-auth-local-key-label">Use a key from my machine</span>
                  <span id="ssh-auth-local-key-summary" className="font-regular text-detail text-muted-foreground">
                    Choose a private key on the device you’re using now.
                  </span>
                </FieldLabel>
                {draft.authentication === "local-key" && (
                  <ChoiceFields labelledBy="ssh-auth-local-key-label">
                    {presetEditor ? (
                      <p id="ssh-auth-local-key-description" className="font-regular text-detail text-muted-foreground">
                        Choose a key from your machine when creating a new SSH subshell. Your key isn’t saved in the
                        preset.
                      </p>
                    ) : isDesktop() ? (
                      <p id="ssh-auth-local-key-description" className="font-regular text-detail text-muted-foreground">
                        Choose a key when you start. It stays on your machine and is released after one authentication
                        attempt or 90 seconds.
                      </p>
                    ) : (
                      <BrowserKeyFields selection={browserKey} busy={busy} />
                    )}
                  </ChoiceFields>
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
                {
                  <span id="ssh-auth-password-description" className="font-regular text-detail text-muted-foreground">
                    {presetEditor
                      ? "When creating a new SSH subshell with this preset, enter your password in the terminal when SSH asks for it. The preset won’t save your password."
                      : "Enter your password in the terminal when SSH asks for it. Subshell won’t save it."}
                  </span>
                }
              </FieldLabel>
            </Field>
          </RadioGroup>
        </fieldset>
        <SshForwardFields
          rows={draft.forwards}
          allowWideBind={machine?.node.sshWideForwards ?? false}
          busy={busy}
          onChange={(forwards) => patch({ forwards })}
        />
      </FieldGroup>
      {!presetEditor && <SaveSshPresetFields draft={draft} onChange={onDraftChange} busy={busy} />}
      {refusal && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="flex items-start gap-2">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="font-strong text-destructive text-detail">
              {presetEditor
                ? "Couldn’t save preset"
                : launchBlocked
                  ? "Connection needs attention"
                  : (refusalTitle ?? "Connection failed")}
            </p>
            <p className="break-words text-detail text-muted-foreground">{refusal}</p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy && (!!presetEditor || draft.authentication !== "local-key")}
          disabledReason={
            presetEditor
              ? "Wait for the preset to finish saving."
              : "Wait for SSH startup to finish, or close the native key picker to cancel selection."
          }
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={disabled}
          disabledReason={
            busy
              ? presetEditor
                ? "Saving the preset."
                : "SSH startup is in progress."
              : launchBlocked
                ? "This SSH subshell already exists. Open it from the subshell list."
                : (Object.values(problems())[0] ??
                  (readiness.isPending
                    ? "Checking which nodes can connect."
                    : readiness.isError
                      ? "Reload the connecting nodes before starting."
                      : presetEditor && machine && !machine.node.canLaunch
                        ? "This machine isn't accepting new subshells right now."
                        : presetEditor && remote && keyMachine && !keyMachine.node.canLaunch
                          ? "The key machine isn't accepting new subshells right now."
                          : !machine?.canConnect && !enableOnStart
                            ? "The connecting node isn't ready. Check the requirements above."
                            : remote
                              ? "Choose available SSH keys from a ready node."
                              : "Complete the connection details above."))
          }
          onClick={() => void form.handleSubmit()}
        >
          {presetEditor ? (busy ? "Saving…" : "Save preset") : busy ? "Starting SSH subshell…" : "Start SSH subshell"}
        </Button>
      </div>
    </section>
  );
}
