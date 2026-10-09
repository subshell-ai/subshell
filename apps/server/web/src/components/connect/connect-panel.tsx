import type { Node } from "@internal/node-admin";
import { Button, Label } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { DestinationField } from "@/components/connect/destination-field";
import { buildDestinationOptions } from "@/components/connect/destination-options";
import { NoSshTargets } from "@/components/connect/no-ssh-targets";
import { SshKeyStep } from "@/components/connect/ssh-key-step";
import { type SshRefusalCopy, sshLaunchRefusal } from "@/components/connect/ssh-refusal";
import {
  type SshInitialChoices,
  type SshSessionDraft,
  type SshWizardIntent,
  sshDestination,
  sshDraftProblems,
  sshKeySelectionProblem,
  sshKeySourceProblem,
  sshSessionDraft,
} from "@/components/connect/ssh-session-draft";
import { SshWizard } from "@/components/connect/ssh-wizard";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";
import { Field, FieldGroup } from "@/components/ui/field";
import { RequiredMark } from "@/components/ui/required-mark";
import {
  useLaunchSsh,
  useSaveSshHost,
  useSetDefaultNode,
  useSshAliases,
  useSshNodeRoster,
  useSshReadiness,
  useSshSavedHosts,
} from "@/hooks/use-ssh";
import { fieldErrorToned, makeForm, useSubmitDisabled } from "@/lib/form";
import { nodeOptionLabel } from "@/lib/node-label";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";

/** Shared SSH launch form for new subshells, workspace additions and splits.
 * A picked suggestion retains its canonical destination; editing it submits
 * the new text directly. Alternate key machines are an advanced choice.
 */
const DESTINATION_IDS = { field: "connect-destination", disclosure: "connect-destination-disclosure" };
const MACHINE_IDS = {
  field: "connect-machine",
  requirement: "connect-machine-requirement",
  refusal: "connect-machine-refusal",
};

/** The disclosure every ssh surface owes before the button (decision 6, verbatim). */
export const SSH_DISCLOSURE_COPY =
  "Connecting uses this machine’s SSH configuration, including any local commands configured with Match exec.";

export function ConnectPanel({
  initial,
  onCreated,
  onLeave,
  onPendingChange,
  draft: controlledDraft,
  onDraftChange,
  startInWizard = false,
  wizardIntent,
  onDone,
}: {
  initial?: SshInitialChoices;
  draft?: SshSessionDraft;
  onDraftChange?: (draft: SshSessionDraft) => void;
  startInWizard?: boolean;
  wizardIntent?: SshWizardIntent;
  onDone?: () => void;
  onCreated?: (id: string) => Promise<void> | void;
  onLeave?: () => void;
  onPendingChange?: (pending: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const nodesQuery = useSshReadiness();
  const { data: nodeData } = nodesQuery;
  const machines = nodeData?.machines ?? null;
  const nodes = machines?.map((machine) => machine.node) ?? null;
  const machineBlocker = (id: string) =>
    machines?.find((machine) => machine.node.id === id)?.blockers[0]?.message ?? null;
  const machineCanConnect = (id: string) =>
    machines?.some((machine) => machine.node.id === id && machine.canConnect) ?? false;
  const { data: ledger, isPending: ledgerPending } = useSshSavedHosts();
  const launch = useLaunchSsh();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    onPendingChange?.(submitting);
    return () => onPendingChange?.(false);
  }, [submitting, onPendingChange]);
  const save = useSaveSshHost();
  const setDefault = useSetDefaultNode();

  const [localDraft, setLocalDraft] = useState(() => sshSessionDraft(initial));
  const draft = controlledDraft ?? localDraft;
  const setDraft = onDraftChange ?? setLocalDraft;
  const nodeId = draft.nodeId;
  const keyHome = draft.keyHome;
  const dest = draft.destination;
  const remember = draft.remember;
  const setNodeId = useCallback((nodeId: string) => setDraft({ ...draft, nodeId }), [draft, setDraft]);
  const setKeyHome = (keyHome: string) => setDraft({ ...draft, keyHome });
  const setDest = (destination: SshSessionDraft["destination"]) => setDraft({ ...draft, destination });
  const setRemember = (remember: boolean) => setDraft({ ...draft, remember });
  const [wizard, setWizard] = useState(startInWizard);
  const [advanced, setAdvanced] = useState(!!initial?.keyHome || !!draft.keyHome);
  const submitGuard = useRef(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<SshRefusalCopy | null>(null);

  const targets = nodes ?? [];
  const selectedNode: Node | null = (nodes ?? []).find((n) => n.id === nodeId) ?? null;
  const defaultNodeId = ledger?.defaultNodeId ?? null;
  const enabledCount = targets.filter((n) => machineCanConnect(n.id)).length;
  const machineReady = !nodesQuery.isError && selectedNode !== null && machineCanConnect(selectedNode.id);
  const selectedBlocker = selectedNode ? machineBlocker(selectedNode.id) : "Choose an available connecting machine.";
  // "Settled" means both feeds have answered, so the pre-fill effect has had
  // its say: a stored default or the only usable machine has landed, or there
  // was nothing to land. From then on an empty machine IS the open question -
  // several doors with no preference, or no door at all (spec §7, decision 2).
  const machineRequired = nodes !== null && !ledgerPending && nodeId === "";

  // The machine disclosure keeps gated-off rows visible (decision 3): grey,
  // with the reason carrying the remedy, not just the cause - the sentence
  // pair mirrors the server's own gate (ssh-launch.service.ts's `gateCause`):
  // the control-plane host's switch is an admin's, every other machine's is
  // its owner's.
  const machineOptions: ComboboxOption[] = targets.map((n) => ({
    value: n.id,
    label: nodeOptionLabel(n),
    disabled: !machineCanConnect(n.id),
    reason: machineBlocker(n.id) ?? undefined,
  }));

  // Aliases are the MACHINE's config, asked only while a gate-ON machine is
  // picked (spec §7: discovery runs where it can answer).
  const aliasesQ = useSshAliases(machineReady && selectedNode ? selectedNode.id : null);
  const aliases = aliasesQ.data?.aliases ?? [];

  const { options: destinationOptions, candidates } = buildDestinationOptions({
    saved: ledger?.saved ?? [],
    recent: ledger?.recent ?? [],
    aliases,
    machineName: selectedNode?.name ?? null,
    typed: dest.typed,
  });

  // The default pre-fill, once and only over an untouched pick: the stored
  // preference wins when its machine is still a usable row; an only child
  // pre-selects honestly; several with no preference stay an open question
  // (decision 2). Keyed on the loaded node list, never on `targets` (a new
  // array every render).
  useEffect(() => {
    if (nodeId !== "" || machines === null) return;
    const usable = machines.filter((machine) => machine.canConnect).map((machine) => machine.node);
    if (defaultNodeId !== null && usable.some((n) => n.id === defaultNodeId)) setNodeId(defaultNodeId);
    else if (usable.length === 1) setNodeId(usable[0].id);
  }, [nodeId, machines, defaultNodeId, setNodeId]);

  const keyOptions: ComboboxOption[] = [
    { value: "connecting", label: "Connecting machine’s own keys" },
    ...(nodes ?? [])
      .filter((n) => n.id !== nodeId || n.id === keyHome)
      .map((n) => ({
        value: n.id,
        label: n.name,
        disabled: n.id === nodeId || !machineCanConnect(n.id),
        reason:
          n.id === nodeId ? "Choose own keys explicitly or another key machine." : (machineBlocker(n.id) ?? undefined),
      })),
  ];
  const keySourceProblem = sshKeySourceProblem(draft);
  const keyReady = !keyHome || keyOptions.some((o) => o.value === keyHome && !o.disabled);
  const roster = useSshNodeRoster(keyHome && keyReady ? keyHome : null, !wizard);
  const fingerprints = draft.selections[keyHome] ?? [];
  const selectionError = sshKeySelectionProblem(fingerprints, roster.data?.identities);
  const rosterReady = !keyHome || (!roster.isPending && !roster.isError && selectionError === null);
  const destination = sshDestination(draft);
  // A committed row's label is the field's text; while that echo stands the
  // list is UNFILTERED (the whole ledger again), because the echo is display,
  // not a search. Any keystroke releases the pick, and text becomes query.
  const pickLabel = dest.pickId !== null ? destinationOptions.find((o) => o.value === dest.pickId)?.label : undefined;
  const destinationQuery = dest.pick !== null && dest.typed === pickLabel ? "" : dest.typed;

  // Editing a suggestion releases its canonical value before another launch.
  function onDestinationText(text: string): void {
    setDest({ pick: null, pickId: null, typed: text });
  }

  /** Clicking (or Enter on) a row commits its candidate; the label becomes
   *  the field's text, which is what a re-opened list then echoes. */
  function pickDestinationOption(option: ComboboxOption): void {
    const candidate = candidates.get(option.value);
    if (candidate === undefined) return;
    setDest({ pick: candidate, pickId: option.value, typed: option.label });
  }

  const form = makeForm({
    defaultValues: { draft },
    validator: ({ draft }): Record<string, string> => {
      const error = Object.values(sshDraftProblems(draft))[0];
      return error ? { draft: error } : {};
    },
    onSubmit: () => submit(),
  });
  useEffect(() => {
    form.setFieldValue("draft", draft);
    void form.validate("change");
  }, [draft, form]);
  const disabled = useSubmitDisabled(form, submitting || !!createdId || !machineReady || !keyReady || !rosterReady);
  const canSubmit =
    !submitting &&
    !createdId &&
    machineReady &&
    keyReady &&
    rosterReady &&
    Object.keys(sshDraftProblems(draft)).length === 0;

  async function submit(): Promise<void> {
    // Belt over gate: the button's own disabled condition already holds both
    // fields, so this can only fire on a render race, never as a silent no-op.
    if (!canSubmit || submitGuard.current) return;
    submitGuard.current = true;
    setSubmitting(true);
    setRefusal(null);
    let launchedId: string | null = null;
    try {
      const created = await launch.mutateAsync({
        node: nodeId,
        destination,
        ...(keyHome ? { keyHome, fingerprints } : {}),
      });
      launchedId = created.subshell.id;
      setCreatedId(launchedId);
      if (remember) {
        // The alias rides ONLY for a config-list pick (an alias token); saved
        // and recent rows already carry their own.
        save.mutate({
          node: nodeId,
          destination,
          ...(dest.pick?.aliasToken !== undefined ? { alias: dest.pick.aliasToken } : {}),
        });
      }
      if (onCreated) await onCreated(created.subshell.id);
      else void navigate({ to: "/subshells/$id", params: { id: created.subshell.id } });
    } catch (err) {
      setRefusal(
        launchedId
          ? {
              field: "destination",
              text: "SSH subshell was created but could not be attached. Add it from the existing subshell list instead.",
            }
          : sshLaunchRefusal(err, selectedNode),
      );
    } finally {
      setSubmitting(false);
      submitGuard.current = false;
    }
  }

  // An open machine question speaks the moment it stands: Connect is disabled
  // while the picker is empty, and a dim button with no sentence is the
  // silent no-op this round refused. Gold, never red - "nothing chosen yet"
  // (ruling 2026-09-30) - and when no enabled machine exists the sentence
  // names the environment, not the person.
  const machineGap = machineRequired
    ? fieldErrorToned([
        {
          message:
            enabledCount > 0
              ? "Choose a connecting machine first."
              : "No SSH-enabled machine is available. Enable SSH on a machine first.",
          gap: true,
        },
      ])
    : null;
  // aria-describedby may name nothing that is not rendered, so the
  // association is exactly the explanation lines currently on screen.
  const machineRefusal = refusal?.field === "machine" ? refusal.text : null;
  const machineDescribedBy =
    [machineGap ? MACHINE_IDS.requirement : null, machineRefusal !== null ? MACHINE_IDS.refusal : null]
      .filter((id): id is string => id !== null)
      .join(" ") || undefined;

  if (wizard)
    return (
      <div className="flex flex-col gap-4">
        <SshWizard
          intent={wizardIntent}
          draft={draft}
          onDraftChange={setDraft}
          machines={machines ?? []}
          readiness={nodesQuery}
          onStart={submit}
          onApplySetup={() => {
            setAdvanced(!!draft.keyHome);
            setWizard(false);
          }}
          onCancel={() => setWizard(false)}
          onDone={onDone ?? (() => setWizard(false))}
          onLeave={onLeave}
          busy={submitting}
          launchBlocked={createdId !== null}
        />
        {refusal && (
          <p role="alert" className="text-destructive text-detail">
            {refusal.text}
          </p>
        )}
      </div>
    );
  if (nodesQuery.isPending || nodesQuery.isError)
    return (
      <div className="flex flex-col gap-4">
        <SshQueryStatus query={nodesQuery} label="connecting machines" />
        <Button type="button" onClick={() => setWizard(true)}>
          SSH Wizard
        </Button>
      </div>
    );
  if (enabledCount === 0) return <NoSshTargets machines={machines ?? []} onWizard={() => setWizard(true)} />;

  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={submitting}
        onClick={() => setWizard(true)}
      >
        SSH Wizard
      </Button>
      <FieldGroup className="gap-4">
        <Field>
          <Label htmlFor={DESTINATION_IDS.field}>SSH destination</Label>
          <DestinationField
            id={DESTINATION_IDS.field}
            describedBy={DESTINATION_IDS.disclosure}
            placeholder="user@hostname:22 or an SSH alias"
            typed={dest.typed}
            query={destinationQuery}
            options={destinationOptions}
            onTextChange={onDestinationText}
            onPick={pickDestinationOption}
          />
          {refusal?.field === "destination" && (
            <p role="alert" className="text-destructive text-detail">
              {refusal.text}
            </p>
          )}
          <p id={DESTINATION_IDS.disclosure} className="text-detail text-muted-foreground">
            Enter the machine you want to access, for example deploy@example.com:22. Saved destinations and SSH aliases
            appear as suggestions.
          </p>
        </Field>

        <Field>
          <Label htmlFor={MACHINE_IDS.field}>
            Connect through
            {machineRequired && <RequiredMark />}
          </Label>
          <SearchableSelect
            id={MACHINE_IDS.field}
            value={nodeId}
            placeholder="Choose a machine"
            options={machineOptions}
            onValueChange={(id) => id !== "" && setNodeId(id)}
            describedBy={machineDescribedBy}
          />
          <p className="text-detail text-muted-foreground">
            {selectedNode
              ? `${selectedNode.name} runs SSH and must be able to reach the destination.`
              : "Choose a Subshell machine that can reach the destination. It runs SSH for this terminal."}
          </p>
          {nodeId !== "" && !machineReady && (
            <p role="status" className="text-detail text-muted-foreground">
              {selectedBlocker} Choose another connecting machine to continue.
            </p>
          )}
          {machineGap && (
            <p id={MACHINE_IDS.requirement} className={REQUIREMENT_CAPTION_CLASS}>
              {machineGap.text}
            </p>
          )}
          {machineRefusal !== null && (
            <p id={MACHINE_IDS.refusal} role="alert" className="text-destructive text-detail">
              {machineRefusal}
            </p>
          )}
          {selectedNode !== null && defaultNodeId !== selectedNode.id && (
            <button
              type="button"
              onClick={() => setDefault.mutate(selectedNode.id)}
              className="text-detail text-muted-foreground underline-offset-2 hover:underline"
            >
              Use by default
            </button>
          )}
        </Field>

        <div>
          <Button
            variant="ghost"
            aria-expanded={advanced || !!keySourceProblem || refusal?.field === "keys"}
            aria-controls="ssh-advanced-options"
            onClick={() => setAdvanced((value) => !value)}
          >
            Advanced SSH options
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          </Button>
          <div id="ssh-advanced-options" hidden={!advanced && !keySourceProblem && refusal?.field !== "keys"}>
            <Field className="mt-3">
              <Label htmlFor="connect-key-home">Use SSH keys from</Label>
              <SearchableSelect
                id="connect-key-home"
                placeholder="Choose a key machine"
                value={keyHome || "connecting"}
                options={keyOptions}
                onValueChange={(id) => {
                  setKeyHome(id === "connecting" ? "" : id);
                  setRefusal(null);
                }}
                describedBy="connect-key-help"
              />
              <p id="connect-key-help" className="text-detail text-muted-foreground">
                Choose another machine to use keys loaded in its SSH agent. Keys stay on that machine; it must be online
                and have SSH enabled.
              </p>
              {keySourceProblem && (
                <p role="alert" className="text-destructive text-detail">
                  {keySourceProblem}
                </p>
              )}
              {!keyReady && !keySourceProblem && (
                <p role="status" className="text-detail text-muted-foreground">
                  The selected key machine is unavailable. Bring it online with SSH enabled, or choose another.
                </p>
              )}
              {refusal?.field === "keys" && (
                <p role="alert" className="text-destructive text-detail">
                  {refusal.text}
                </p>
              )}
              {keyHome && keyReady && (
                <SshKeyStep
                  nodeId={keyHome}
                  fingerprints={fingerprints}
                  onChange={(fingerprints) =>
                    setDraft({ ...draft, selections: { ...draft.selections, [keyHome]: fingerprints } })
                  }
                />
              )}
            </Field>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="connect-remember"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 rounded border border-input bg-background accent-primary"
          />
          <Label htmlFor="connect-remember">Remember this destination</Label>
        </div>

        <p className="text-detail text-muted-foreground">{SSH_DISCLOSURE_COPY}</p>
        <Button type="button" onClick={() => void form.handleSubmit()} disabled={disabled}>
          {submitting ? "Connecting…" : "Start SSH subshell"}
        </Button>
      </FieldGroup>
    </div>
  );
}
