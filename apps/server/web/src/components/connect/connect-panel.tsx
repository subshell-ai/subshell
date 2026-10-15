import type { Node } from "@internal/node-admin";
import { ApiError, Button, errMessage, Label } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { useBrowserKeySelection } from "@/components/connect/browser-key-fields";
import { DestinationField } from "@/components/connect/destination-field";
import { buildDestinationOptions } from "@/components/connect/destination-options";
import { NoSshTargets } from "@/components/connect/no-ssh-targets";
import { SshKeyStep } from "@/components/connect/ssh-key-step";
import { SaveSshPresetFields, SshPresetPicker } from "@/components/connect/ssh-preset-controls";
import { type SshRefusalCopy, sshLaunchRefusal } from "@/components/connect/ssh-refusal";
import {
  type SshInitialChoices,
  type SshSessionDraft,
  sshDestination,
  sshDraftProblems,
  sshKeySelectionProblem,
  sshKeySourceProblem,
  sshSessionDraft,
} from "@/components/connect/ssh-session-draft";
import { SshWizard } from "@/components/connect/ssh-wizard";
import { verifyBrowserKeyDestination } from "@/components/connect/verify-browser-key-destination";
import { launchWithDestinationVerification } from "@/components/connect/verify-destination";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";
import { Field, FieldGroup } from "@/components/ui/field";
import { RequiredMark } from "@/components/ui/required-mark";
import {
  useLaunchSsh,
  useSetDefaultNode,
  useSetSshEnabled,
  useSshAliases,
  useSshNodeRoster,
  useSshReadiness,
  useSshRecentDestinations,
} from "@/hooks/use-ssh";
import { useSaveSshPreset } from "@/hooks/use-ssh-presets";
import { isDesktop } from "@/lib/desktop";
import { fieldErrorToned, makeForm, useSubmitDisabled } from "@/lib/form";
import { nodeOptionLabel } from "@/lib/node-label";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import { sshCanEnableOnStart } from "@/lib/ssh";
import { sshDestinationProblem } from "@/lib/ssh-input-validation";
import { launchWithLocalKey } from "@/lib/ssh-local-key";
import { sshDraftFromPreset, sshPresetPayload } from "@/lib/ssh-preset";
import type { SshPreset } from "@/types/preset";

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

export function ConnectPanel({
  initial,
  onCreated,
  onLeave,
  onPendingChange,
  draft: controlledDraft,
  onDraftChange,
  startInWizard = true,
  onDone,
}: {
  initial?: SshInitialChoices;
  draft?: SshSessionDraft;
  onDraftChange?: (draft: SshSessionDraft) => void;
  startInWizard?: boolean;
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
  const { data: ledger, isPending: ledgerPending } = useSshRecentDestinations();
  const launch = useLaunchSsh();
  const browserKey = useBrowserKeySelection();
  const localKeyAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = () => localKeyAbort.current?.abort();
    window.addEventListener("pagehide", abort);
    return () => {
      window.removeEventListener("pagehide", abort);
      abort();
    };
  }, []);
  const enableSsh = useSetSshEnabled();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    onPendingChange?.(submitting);
    return () => onPendingChange?.(false);
  }, [submitting, onPendingChange]);
  const savePreset = useSaveSshPreset();
  const savedAttempt = useRef<{ signature: string; preset: SshPreset } | null>(null);
  const setDefault = useSetDefaultNode();

  const [localDraft, setLocalDraft] = useState(() => sshSessionDraft(initial));
  const draft = controlledDraft ?? localDraft;
  const writeDraft = onDraftChange ?? setLocalDraft;
  // Manual choices release a pending URL preset so a late response cannot replace this draft.
  const setDraft = useCallback(
    (next: SshSessionDraft) => writeDraft({ ...next, initialPresetId: undefined }),
    [writeDraft],
  );
  const signingScope = JSON.stringify([draft.authentication, draft.nodeId, sshDestination(draft)]);
  const previousSigningScope = useRef(signingScope);
  useEffect(() => {
    if (previousSigningScope.current === signingScope) return;
    previousSigningScope.current = signingScope;
    localKeyAbort.current?.abort();
  }, [signingScope]);
  useEffect(() => {
    // Before Start, this is only a file selection. Destination edits must not
    // discard it; approval binds the imported key to the final destination.
    if (draft.authentication !== "local-key") browserKey.clear();
  }, [draft.authentication, browserKey.clear]);
  const applyPreset = useCallback(
    (preset: SshPreset) => {
      localKeyAbort.current?.abort();
      browserKey.clear();
      savedAttempt.current = null;
      setWizard(true);
      setRefusal(null);
      setDraft(sshDraftFromPreset(preset));
    },
    [browserKey.clear, setDraft],
  );
  const nodeId = draft.nodeId;
  const keyHome = draft.keyHome;
  const dest = draft.destination;
  const setNodeId = useCallback((nodeId: string) => setDraft({ ...draft, nodeId }), [draft, setDraft]);
  const setKeyHome = (keyHome: string) =>
    setDraft({ ...draft, keyHome, authentication: keyHome ? "remote" : "connecting" });
  const setDest = (destination: SshSessionDraft["destination"]) =>
    setDraft({ ...draft, destination, expectedDestination: undefined, resolutionAlias: undefined });
  const [wizard, setWizard] = useState(startInWizard);
  const [advanced, setAdvanced] = useState(!!initial?.keyHome || !!draft.keyHome);
  const submitGuard = useRef(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<SshRefusalCopy | null>(null);
  const presetPicker = (
    <SshPresetPicker
      initialId={draft.initialPresetId}
      onApply={applyPreset}
      disabled={submitting || createdId !== null}
      initialEligible={!browserKey.name && !browserKey.trusted}
    />
  );

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
    recent: ledger?.recent ?? [],
    aliases,
    destinations: aliasesQ.data?.destinations,
    machineName: selectedNode?.name ?? null,
    typed: dest.typed,
  });

  // The default pre-fill, once and only over an untouched pick: the stored
  // preference wins when its machine is still a usable row; an only child
  // pre-selects honestly; several with no preference stay an open question
  // (decision 2). Keyed on the loaded node list, never on `targets` (a new
  // array every render).
  useEffect(() => {
    if (nodeId !== "" || machines === null || draft.presetApplied || draft.initialPresetId) return;
    const usable = machines.filter((machine) => machine.canConnect).map((machine) => machine.node);
    if (defaultNodeId !== null && usable.some((n) => n.id === defaultNodeId)) setNodeId(defaultNodeId);
    else if (usable.length === 1) setNodeId(usable[0].id);
  }, [nodeId, machines, defaultNodeId, setNodeId, draft.presetApplied, draft.initialPresetId]);

  const keyOptions: ComboboxOption[] = [
    { value: "connecting", label: "Keys on the connecting machine" },
    ...(nodes ?? [])
      .filter((n) => n.id !== nodeId || n.id === keyHome)
      .map((n) => ({
        value: n.id,
        label: n.name,
        disabled: n.id === nodeId || !machineCanConnect(n.id),
        reason:
          n.id === nodeId
            ? "Use keys on this machine, or choose a different machine."
            : (machineBlocker(n.id) ?? undefined),
      })),
  ];
  const keySourceProblem = sshKeySourceProblem(draft);
  const enableKeysOnStart =
    wizard && !!keyHome && keyHome !== nodeId && sshCanEnableOnStart(machines?.find((m) => m.node.id === keyHome));
  const keyReady = enableKeysOnStart || !keyHome || keyOptions.some((o) => o.value === keyHome && !o.disabled);
  const roster = useSshNodeRoster(keyHome && keyReady && !enableKeysOnStart ? keyHome : null, !wizard);
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
  const enableOnStart = wizard && sshCanEnableOnStart(machines?.find((m) => m.node.id === nodeId));
  const canSubmit =
    !submitting &&
    !createdId &&
    (machineReady || enableOnStart) &&
    keyReady &&
    (rosterReady || enableKeysOnStart) &&
    (enableKeysOnStart
      ? !!nodeId && !!destination && !keySourceProblem
      : Object.keys(sshDraftProblems(draft)).length === 0);

  async function submit(): Promise<void> {
    // Belt over gate: the button's own disabled condition already holds both
    // fields, so this can only fire on a render race, never as a silent no-op.
    if (!canSubmit || submitGuard.current) return;
    if (draft.authentication === "local-key" && !isDesktop() && browserKey.problem()) return;
    submitGuard.current = true;
    if (draft.initialPresetId) setDraft(draft);
    const attempt = new AbortController();
    localKeyAbort.current = attempt;
    const cancelled = () => draft.authentication === "local-key" && attempt.signal.aborted;
    setSubmitting(true);
    setRefusal(null);
    let launchedId: string | null = null;
    let savingPreset = false;
    let preparing = enableOnStart || enableKeysOnStart;
    try {
      const nodesToEnable = [...(enableKeysOnStart ? [keyHome] : []), ...(enableOnStart ? [nodeId] : [])];
      if (nodesToEnable.length) {
        const fresh = await nodesQuery.refetch();
        if (cancelled()) return;
        for (const id of [nodeId, ...(keyHome ? [keyHome] : [])]) {
          const current = fresh.data?.machines.find((m) => m.node.id === id);
          if (
            fresh.isError ||
            !current ||
            (!current.canConnect && !(nodesToEnable.includes(id) && sshCanEnableOnStart(current)))
          )
            throw new Error("This node can't enable SSH right now. Check its status and your permissions.");
        }
        for (const id of nodesToEnable) {
          const current = fresh.data?.machines.find((m) => m.node.id === id);
          if (!current?.node.sshEnabled) await enableSsh.mutateAsync({ id, on: true });
          if (cancelled()) return;
        }
        const refreshed = await nodesQuery.refetch();
        if (cancelled()) return;
        if (
          refreshed.isError ||
          [nodeId, ...(keyHome ? [keyHome] : [])].some(
            (id) => !refreshed.data?.machines.find((m) => m.node.id === id)?.canConnect,
          )
        )
          throw new Error("SSH was enabled, but a selected node isn't ready. Check its status before trying again.");
        // Roster access is gated by SSH enablement. Let the user choose an explicit
        // key subset after it becomes readable; never substitute the entire roster.
        if (enableKeysOnStart) return;
      }
      if (cancelled()) return;
      preparing = false;
      let expectedDestination = draft.expectedDestination;
      if (draft.saveAsPreset) {
        savingPreset = true;
        const payload = sshPresetPayload(draft, draft.presetName ?? "");
        const signature = JSON.stringify(payload);
        const preset =
          savedAttempt.current?.signature === signature
            ? savedAttempt.current.preset
            : await savePreset.mutateAsync({ payload });
        savedAttempt.current = { signature, preset };
        expectedDestination = preset.destination;
        savingPreset = false;
      }
      if (cancelled()) return;
      const launchRequest = {
        ...(draft.authentication === "password" ? { authentication: "password" as const } : {}),
        node: nodeId,
        destination,
        ...(expectedDestination ? { expectedDestination } : {}),
        ...(keyHome ? { keyHome, fingerprints } : {}),
      };
      const created =
        draft.authentication === "local-key"
          ? await launchWithLocalKey(
              launchRequest,
              launch.mutateAsync,
              (id) => {
                launchedId = id;
                setCreatedId(id);
              },
              attempt.signal,
              isDesktop()
                ? undefined
                : {
                    take: browserKey.take,
                    confirm: (target) => {
                      const node = nodes?.find((candidate) => candidate.id === nodeId);
                      if (!node)
                        throw new Error("The connecting node's details are unavailable. Select the node again.");
                      return verifyBrowserKeyDestination(target, {
                        keyFileName: browserKey.name,
                        nodeName: node.name,
                      });
                    },
                  },
              () => {
                launchedId = null;
                setCreatedId(null);
              },
            )
          : await launchWithDestinationVerification(
              {
                ...(draft.authentication === "password" ? { authentication: "password" as const } : {}),
                node: nodeId,
                destination,
                ...(expectedDestination ? { expectedDestination } : {}),
                ...(keyHome ? { keyHome, fingerprints } : {}),
              },
              launch.mutateAsync,
            );
      if (!created) return;
      if (draft.authentication === "local-key") browserKey.clear();
      launchedId = created.subshell.id;
      setCreatedId(launchedId);
      if (onCreated) await onCreated(created.subshell.id);
      else void navigate({ to: "/subshells/$id", params: { id: created.subshell.id } });
    } catch (err) {
      if (cancelled()) return;
      setRefusal(
        savingPreset && !(err instanceof ApiError && err.status === 422)
          ? {
              field: "destination",
              text: errMessage(err, "Couldn’t save this preset. Your connection hasn’t started."),
            }
          : launchedId
            ? {
                field: "destination",
                text:
                  draft.authentication === "local-key"
                    ? errMessage(
                        err,
                        "The SSH subshell was created, but temporary key authentication did not finish. Check its terminal before starting another connection.",
                      )
                    : "SSH subshell was created but could not be attached. Add it from the existing subshell list instead.",
              }
            : preparing
              ? { field: "machine", text: errMessage(err, "Couldn’t enable SSH and start the subshell.") }
              : sshLaunchRefusal(err, selectedNode, draft.authentication === "local-key"),
      );
    } finally {
      if (localKeyAbort.current === attempt) {
        localKeyAbort.current = null;
      }
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
              ? "Choose a node to connect from first."
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
        {presetPicker}
        <SshWizard
          draft={draft}
          browserKey={browserKey}
          onDraftChange={setDraft}
          machines={machines ?? []}
          readiness={nodesQuery}
          onStart={submit}
          onCancel={() => {
            localKeyAbort.current?.abort();
            browserKey.clear();
            (onLeave ?? onDone ?? (() => setWizard(false)))();
          }}
          onLeave={onLeave}
          busy={submitting}
          launchBlocked={createdId !== null}
          refusal={refusal?.text}
        />
      </div>
    );
  if (nodesQuery.isPending || nodesQuery.isError)
    return (
      <div className="flex flex-col gap-4">
        <SshQueryStatus query={nodesQuery} label="connecting machines" />
        <Button type="button" onClick={() => setWizard(true)}>
          Set up SSH
        </Button>
      </div>
    );
  if (enabledCount === 0) return <NoSshTargets onWizard={() => setWizard(true)} />;

  return (
    <div className="flex flex-col gap-4">
      {presetPicker}
      <FieldGroup className="gap-4">
        <Field>
          <Label htmlFor={DESTINATION_IDS.field}>SSH destination</Label>
          <DestinationField
            problem={sshDestinationProblem(sshDestination(draft))}
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
            Enter the machine you want to access, for example deploy@example.com:22. Recent destinations and SSH aliases
            appear as suggestions.
          </p>
        </Field>

        <Field>
          <Label htmlFor={MACHINE_IDS.field}>
            Connect from
            {machineRequired && <RequiredMark />}
          </Label>
          <SearchableSelect
            id={MACHINE_IDS.field}
            value={nodeId}
            placeholder="Choose a node"
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
            <p role="status" className="text-detail text-warning">
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
              title="Preselects this node for your future SSH connections."
              className="text-detail text-muted-foreground underline-offset-2 hover:underline"
            >
              Select this node by default
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
              <Label htmlFor="connect-key-home">Use keys from</Label>
              <SearchableSelect
                id="connect-key-home"
                placeholder="Choose a node for keys"
                value={keyHome || "connecting"}
                options={keyOptions}
                onValueChange={(id) => {
                  setKeyHome(id === "connecting" ? "" : id);
                  setRefusal(null);
                }}
                describedBy="connect-key-help"
              />
              <p id="connect-key-help" className="text-detail text-muted-foreground">
                {keyOptions.length === 1
                  ? "No other nodes are available to supply SSH keys. This connection will use keys on the connecting node."
                  : "Choose another node to use keys loaded in its SSH agent. You need launch access to that node, and it must be online with SSH enabled. Private keys stay on that node."}
              </p>
              {keySourceProblem && (
                <p role="alert" className="text-destructive text-detail">
                  {keySourceProblem}
                </p>
              )}
              {!keyReady && !keySourceProblem && (
                <p role="status" className="text-detail text-muted-foreground">
                  The machine supplying your keys is unavailable. Bring it online and enable SSH in Subshell, or choose
                  another machine.
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

        <SaveSshPresetFields draft={draft} onChange={setDraft} busy={submitting} />

        <Button type="button" variant="outline" disabled={submitting} onClick={() => setWizard(true)}>
          Back
        </Button>
        <Button type="button" onClick={() => void form.handleSubmit()} disabled={disabled}>
          {submitting ? "Connecting…" : "Start SSH subshell"}
        </Button>
      </FieldGroup>
    </div>
  );
}
