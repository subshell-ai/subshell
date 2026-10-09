import type { Node } from "@internal/node-admin";
import { Button, Label } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { DestinationField } from "@/components/connect/destination-field";
import { buildDestinationOptions, type DestinationCandidate } from "@/components/connect/destination-options";
import { NoSshTargets } from "@/components/connect/no-ssh-targets";
import { type SshRefusalCopy, sshLaunchRefusal } from "@/components/connect/ssh-refusal";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { Checkbox } from "@/components/ui/checkbox";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { fieldErrorToned } from "@/lib/form";
import { nodeOptionLabel } from "@/lib/node-label";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import { sshSelectionError } from "@/lib/ssh";

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

/** The destination field's committed state, held as ONE value so a pick and
 *  the text echo that follows it cannot interleave into a stale pair. */
interface DestinationState {
  /** The picked row's wire meaning; null = nothing committed yet */
  pick: DestinationCandidate | null;
  /** The picked row's option id (the picker's held value) */
  pickId: string | null;
  /** The input's live text (feeds the typed mirror row; not a commitment) */
  typed: string;
}

export function ConnectPanel({
  initial,
  onCreated,
  onLeave,
  onPendingChange,
}: {
  initial?: { node?: string; destination?: string; keyHome?: string };
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

  const [nodeId, setNodeId] = useState(initial?.node ?? "");
  const [keyHome, setKeyHome] = useState(initial?.keyHome ?? "");
  const [dest, setDest] = useState<DestinationState>({
    pick: initial?.destination ? { destination: initial.destination } : null,
    pickId: null,
    typed: initial?.destination ?? "",
  });
  const [advanced, setAdvanced] = useState(!!initial?.keyHome);
  const [selection, setSelection] = useState<{ node: string; fingerprints: string[] } | null>(null);
  const [remember, setRemember] = useState(false);
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
  }, [nodeId, machines, defaultNodeId]);

  const keyOptions: ComboboxOption[] = [
    { value: "connecting", label: "Connecting machine’s own keys" },
    ...(nodes ?? [])
      .filter((n) => n.kind === "agent" && n.id !== nodeId)
      .map((n) => ({
        value: n.id,
        label: n.name,
        disabled: selectedNode?.kind !== "agent" || !machineCanConnect(n.id),
        reason:
          selectedNode?.kind !== "agent"
            ? "Choose a node as the connecting machine first"
            : (machineBlocker(n.id) ?? undefined),
      })),
  ];
  const effectiveKeyHome = keyHome === nodeId ? "" : keyHome;
  const keyReady = !effectiveKeyHome || keyOptions.some((o) => o.value === effectiveKeyHome && !o.disabled);
  const roster = useSshNodeRoster(effectiveKeyHome && keyReady ? effectiveKeyHome : null);
  const fingerprints =
    selection?.node === effectiveKeyHome
      ? selection.fingerprints
      : (roster.data?.identities.map((key) => key.fingerprint) ?? []);
  const selectionError = sshSelectionError(fingerprints);
  const rosterReady = !effectiveKeyHome || (!roster.isPending && !roster.isError && selectionError === null);
  const destination = dest.pick?.destination ?? dest.typed.trim();
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

  const canSubmit = !submitting && machineReady && destination !== "" && keyReady && rosterReady;

  async function submit(): Promise<void> {
    // Belt over gate: the button's own disabled condition already holds both
    // fields, so this can only fire on a render race, never as a silent no-op.
    if (!canSubmit) return;
    setSubmitting(true);
    setRefusal(null);
    try {
      const created = await launch.mutateAsync({
        node: nodeId,
        destination,
        ...(effectiveKeyHome ? { keyHome: effectiveKeyHome, fingerprints } : {}),
      });
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
      setRefusal(sshLaunchRefusal(err, selectedNode));
    } finally {
      setSubmitting(false);
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

  if (nodesQuery.isPending || nodesQuery.isError)
    return <SshQueryStatus query={nodesQuery} label="connecting machines" />;
  if (enabledCount === 0) return <NoSshTargets machines={machines ?? []} onLeave={onLeave} />;

  return (
    <div className="flex flex-col gap-4">
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
            aria-expanded={advanced || refusal?.field === "keys"}
            aria-controls="ssh-advanced-options"
            onClick={() => setAdvanced((value) => !value)}
          >
            Advanced SSH options
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          </Button>
          <div id="ssh-advanced-options" hidden={!advanced && refusal?.field !== "keys"}>
            <Field className="mt-3">
              <Label htmlFor="connect-key-home">Use SSH keys from</Label>
              <SearchableSelect
                id="connect-key-home"
                placeholder="Choose a key machine"
                value={effectiveKeyHome || "connecting"}
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
              {!keyReady && (
                <p role="status" className="text-detail text-muted-foreground">
                  The selected key machine is unavailable. Bring it online with SSH enabled, or choose another.
                </p>
              )}
              {refusal?.field === "keys" && (
                <p role="alert" className="text-destructive text-detail">
                  {refusal.text}
                </p>
              )}
              {effectiveKeyHome && (
                <>
                  <SshQueryStatus query={roster} label="SSH agent keys" />
                  {roster.data && (
                    <fieldset className="flex flex-col gap-2">
                      <legend className="text-label">SSH agent keys</legend>
                      {roster.data.identities.map((key, index) => (
                        <Field key={key.fingerprint}>
                          <Checkbox
                            id={`ssh-key-${index}`}
                            checked={fingerprints.includes(key.fingerprint)}
                            onCheckedChange={(checked) =>
                              setSelection({
                                node: effectiveKeyHome,
                                fingerprints: checked
                                  ? [...fingerprints, key.fingerprint]
                                  : fingerprints.filter((value) => value !== key.fingerprint),
                              })
                            }
                          />
                          <FieldLabel htmlFor={`ssh-key-${index}`}>{key.comment || key.fingerprint}</FieldLabel>
                        </Field>
                      ))}
                      {roster.data.identities.length === 0 && (
                        <p className="text-detail text-muted-foreground">
                          No keys are loaded in this machine's SSH agent.
                        </p>
                      )}
                      {selectionError && (
                        <p role="alert" className="text-destructive text-detail">
                          {selectionError}
                        </p>
                      )}
                    </fieldset>
                  )}
                </>
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
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? "Connecting…" : "Start SSH subshell"}
        </Button>
      </FieldGroup>
    </div>
  );
}
