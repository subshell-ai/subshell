import { Button } from "@internal/node-admin";
import { KeyRound, Network, Server } from "lucide-react";
import { useEffect, useRef } from "react";
import { SshDestinationStep } from "@/components/connect/ssh-destination-step";
import { SshEnrollmentStep } from "@/components/connect/ssh-enrollment-step";
import { SshKeyStep } from "@/components/connect/ssh-key-step";
import { SshMachineSetup, SshMachineStep } from "@/components/connect/ssh-machine-step";
import {
  SSH_STEP_LABELS,
  type SshSessionDraft,
  type SshWizardIntent,
  sshDestination,
  sshKeySelectionProblem,
} from "@/components/connect/ssh-session-draft";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { FieldGroup } from "@/components/ui/field";
import { useSshWizardController } from "@/hooks/use-ssh-wizard-controller";
import { NODE_ENROLLMENT_OFF_COPY } from "@/lib/node-enrollment";
import type { SshMachineReadiness } from "@/lib/ssh";

export interface SshWizardProps {
  /** Optional entry intent. Null opens the three intent actions. */
  intent?: SshWizardIntent;
  /** Shared with the connection form and retained by the outer dialog. */
  draft: SshSessionDraft;
  /** Writes canonical choices, including an explicitly empty key selection. */
  onDraftChange: (draft: SshSessionDraft) => void;
  /** Readiness is supplied by the mounted content host. */
  machines: SshMachineReadiness[];
  /** Retrying never discards the draft or enrollment key. */
  readiness: { isPending: boolean; isError: boolean; refetch: () => unknown };
  /** Actual launch only; setup completion never invokes it. */
  onStart: () => Promise<void>;
  /** Return to the same host's connection form. */
  onApplySetup: () => void;
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

/** Content-only wizard: stable step ids, explicit setup acts, no nested dialog or navigation on creation. */
export function SshWizard({
  intent: initialIntent,
  draft,
  onDraftChange,
  machines,
  readiness,
  onStart,
  onApplySetup,
  onDone,
  onCancel,
  onLeave,
  busy,
  launchBlocked,
}: SshWizardProps) {
  const {
    intent,
    current,
    setCurrent,
    setAdding,
    enrollment,
    mayAdd,
    machine,
    keyMachine,
    remote,
    fingerprints,
    roster,
    steps,
    index,
    form,
    disabled,
    selectIntent,
    patch,
    chooseKeys,
  } = useSshWizardController({
    intent: initialIntent,
    draft,
    onDraftChange,
    machines,
    readiness,
    onStart,
    onApplySetup,
    onDone,
    onCancel,
    onLeave,
    busy,
    launchBlocked,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every step transition must move keyboard focus
  useEffect(() => {
    heading.current?.focus();
  }, [current]);

  return (
    <section className="flex flex-col gap-4" aria-label="SSH Wizard">
      <div className="flex flex-col gap-1">
        <h2 ref={heading} tabIndex={-1} className="font-strong text-section">
          {SSH_STEP_LABELS[current]}
        </h2>
        <p className="text-detail text-muted-foreground">
          {intent
            ? `Step ${index + 1} of ${steps.length}${steps[index + 1] ? ` · Next: ${SSH_STEP_LABELS[steps[index + 1]]}` : ""}`
            : "Choose what you want to set up."}
        </p>
      </div>
      <SshQueryStatus query={readiness} label="connecting machines" />
      {current === "intent" && (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" onClick={() => selectIntent("connect")}>
            <Network data-icon="inline-start" />
            Connect to a destination
          </Button>
          <Button type="button" variant="outline" onClick={() => selectIntent("prepare")}>
            <Server data-icon="inline-start" />
            Prepare a machine for SSH
          </Button>
          <Button type="button" variant="outline" onClick={() => selectIntent("remote-keys")}>
            <KeyRound data-icon="inline-start" />
            Use keys from another machine
          </Button>
        </div>
      )}
      {current === "destination" && (
        <SshDestinationStep
          draft={draft}
          onChange={onDraftChange}
          nodeName={machine?.node.name}
          ready={machine?.canConnect ?? false}
        />
      )}
      {current === "machine" && (
        <FieldGroup>
          <SshMachineStep
            machines={machines}
            value={draft.nodeId}
            onChange={(nodeId) => {
              setAdding(false);
              patch({ nodeId });
            }}
            label={intent === "prepare" ? "Machine to prepare" : "Connect through"}
          />
          <p className="text-detail text-muted-foreground">
            This machine runs SSH and must be able to reach the destination. Its normal SSH identity files work without
            an SSH agent.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={!mayAdd}
            onClick={() => {
              setAdding(true);
              setCurrent("enrollment");
            }}
          >
            Add a machine
          </Button>
          {!mayAdd && <p className="text-detail text-muted-foreground">{NODE_ENROLLMENT_OFF_COPY}</p>}
        </FieldGroup>
      )}
      {current === "enrollment" && (
        <SshEnrollmentStep enrollment={enrollment} mayAdd={mayAdd} machines={machines} readiness={readiness} />
      )}
      {current === "machine-setup" && <SshMachineSetup machine={machine} retry={readiness.refetch} onLeave={onLeave} />}
      {current === "key-choice" && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant={!remote ? "default" : "outline"}
            onClick={() => {
              patch({ keyHome: "" });
              setCurrent("review");
            }}
          >
            Use connecting machine’s own keys
          </Button>
          <Button type="button" variant={remote ? "default" : "outline"} onClick={() => setCurrent("key-source")}>
            Use keys from another machine
          </Button>
        </div>
      )}
      {current === "key-source" && (
        <SshMachineStep
          machines={machines.filter((machine) => machine.node.canLaunch)}
          value={draft.keyHome}
          onChange={chooseKeys}
          exclude={draft.nodeId}
          label="Use SSH keys from"
        />
      )}
      {current === "key-setup" && <SshMachineSetup machine={keyMachine} retry={readiness.refetch} onLeave={onLeave} />}
      {current === "keys" && (
        <SshKeyStep
          nodeId={keyMachine?.canConnect ? draft.keyHome : null}
          fingerprints={fingerprints}
          onChange={(selection) => patch({ selections: { ...draft.selections, [draft.keyHome]: selection } })}
        />
      )}
      {(current === "review" || current === "readiness") && (
        <FieldGroup>
          <p className="text-body">
            {machine?.node.name ?? "Selected machine unavailable"}
            {sshDestination(draft) && ` → ${sshDestination(draft)}`}
          </p>
          <SshMachineSetup machine={machine} retry={readiness.refetch} onLeave={onLeave} />
          {remote && intent !== "prepare" && (
            <>
              <p className="text-detail">
                Keys from {keyMachine?.node.name ?? "unavailable machine"}: {fingerprints.join(", ")}
              </p>
              <SshMachineSetup machine={keyMachine} retry={readiness.refetch} onLeave={onLeave} />
              <SshQueryStatus query={roster} label="SSH agent keys" />
              {sshKeySelectionProblem(fingerprints, roster.data?.identities) && (
                <p role="alert" className="text-destructive text-detail">
                  {sshKeySelectionProblem(fingerprints, roster.data?.identities)}
                </p>
              )}
            </>
          )}
          <p className="text-detail text-muted-foreground">
            Readiness does not test destination authentication. Connecting uses this machine’s SSH configuration,
            including any local commands configured with Match exec.
          </p>
        </FieldGroup>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel wizard
        </Button>
        {current !== "intent" && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (current === "key-source" && intent === "connect") setCurrent("key-choice");
              else setCurrent(steps[index - 1] ?? "intent");
            }}
          >
            Back
          </Button>
        )}
        {current === "readiness" ? (
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={onDone}>
              Done
            </Button>
            <Button type="button" disabled={disabled} onClick={onApplySetup}>
              {intent === "remote-keys" ? "Use this setup" : "Connect now"}
            </Button>
          </>
        ) : (
          !["intent", "key-choice"].includes(current) && (
            <Button type="button" disabled={disabled} onClick={() => void form.handleSubmit()}>
              {busy ? "Starting SSH subshell…" : current === "review" ? "Start SSH subshell" : "Continue"}
            </Button>
          )
        )}
      </div>
    </section>
  );
}
