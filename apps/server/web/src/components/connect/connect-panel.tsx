import type { Node } from "@internal/node-admin";
import { Button, Label } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useEffect, useState } from "react";
import { DestinationField } from "@/components/connect/destination-field";
import { buildDestinationOptions, type DestinationCandidate } from "@/components/connect/destination-options";
import { SavedHostsSection } from "@/components/connect/saved-hosts-section";
import { type SshRefusalCopy, sshLaunchRefusal } from "@/components/connect/ssh-refusal";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";
import { RequiredMark } from "@/components/ui/required-mark";
import { useNodes } from "@/hooks/use-nodes";
import { useLaunchSsh, useSaveSshHost, useSetDefaultNode, useSshAliases, useSshSavedHosts } from "@/hooks/use-ssh";
import { fieldErrorToned } from "@/lib/form";
import { nodeOptionLabel } from "@/lib/node-label";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import { launchableNodes } from "@/lib/subshell-compat";

/**
 * The destination-first Connect flow (spec 2026-10-07 §7, decision 2): the
 * destination leads, the connecting machine follows as a disclosure line,
 * and one POST opens the pane - the SERVER resolves, so selecting a row is
 * display, never a pre-resolve step. Three nouns only (the §11 vocabulary):
 * destination, connecting machine. No key-source affordance (that is M2).
 *
 * A machine whose SSH is off stays VISIBLE and disabled with its reason -
 * greying explains, hiding does not (decision 3). With no default machine and
 * several SSH-enabled ones the disclosure is required with the gold `*` and
 * never silently chosen; with a preference or exactly one usable machine it
 * pre-selects honestly and stays on screen. The disclosure sentence (the
 * `Match exec` note, decision 6) ships verbatim under the destination field,
 * before the button, because approving a destination approves running its
 * resolution.
 *
 * The destination is one COMMITTED candidate: a picked row's meaning, or
 * nothing. Typed text becomes a candidate through the mirror row the list
 * offers (free text accepted, §7), and the commitment releases under any
 * later edit, so the field's text and the launch's truth cannot drift.
 * The field is the working-directory field's input-plus-panel posture
 * (`destination-field.tsx`), not the shared combobox: the list must swap on
 * every keystroke, which is exactly what Base UI's held input cannot keep.
 * Refusals render on the field they belong to, in red, from
 * `ssh-refusal.ts`; the 422's settings list comes from the parsed body,
 * because the display message is sliced. Remembering is explicit: every
 * launch is already recent server-side; the checkbox PUTs the saved row only
 * when checked, sending the alias only for a pick from the machine's own
 * config list (§7's alias-is-display rule).
 */
const DESTINATION_IDS = { field: "connect-destination", disclosure: "connect-destination-disclosure" };
const MACHINE_IDS = { field: "connect-machine", requirement: "connect-machine-requirement" };

/** The disclosure every ssh surface owes before the button (decision 6, verbatim). */
export const SSH_DISCLOSURE_COPY =
  "Resolving asks the connecting machine to read its SSH config. A hidden Match exec in that config can run a local command while it resolves.";

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

export function ConnectPanel(): JSX.Element {
  const navigate = useNavigate();
  const { data: nodeData } = useNodes();
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : null;
  const { data: ledger } = useSshSavedHosts();
  const launch = useLaunchSsh();
  const save = useSaveSshHost();
  const setDefault = useSetDefaultNode();

  const [nodeId, setNodeId] = useState("");
  const [dest, setDest] = useState<DestinationState>({ pick: null, pickId: null, typed: "" });
  const [remember, setRemember] = useState(false);
  // The gold caption waits for a submit that found the machine untouched:
  // "nothing typed yet", never before the first attempt (ruling 2026-09-30).
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [refusal, setRefusal] = useState<SshRefusalCopy | null>(null);

  const targets = launchableNodes(nodes ?? []);
  const selectedNode: Node | null = (nodes ?? []).find((n) => n.id === nodeId) ?? null;
  const defaultNodeId = ledger?.defaultNodeId ?? null;
  const enabledCount = targets.filter((n) => n.sshEnabled).length;
  // No preference, several doors: the choice is the human's (spec §7).
  const machineRequired = nodeId === "" && defaultNodeId === null && enabledCount > 1;

  // The machine disclosure keeps gated-off rows visible (decision 3): grey,
  // with the reason naming what is in the way.
  const machineOptions: ComboboxOption[] = targets.map((n) => ({
    value: n.id,
    label: nodeOptionLabel(n),
    disabled: !n.sshEnabled,
    reason: n.sshEnabled ? undefined : "SSH is off on this machine",
  }));

  // Aliases are the MACHINE's config, asked only while a gate-ON machine is
  // picked (spec §7: discovery runs where it can answer).
  const aliasesQ = useSshAliases(selectedNode?.sshEnabled ? selectedNode.id : null);
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
    if (nodeId !== "" || nodes === null) return;
    const usable = launchableNodes(nodes).filter((n) => n.sshEnabled);
    if (defaultNodeId !== null && usable.some((n) => n.id === defaultNodeId)) {
      setNodeId(defaultNodeId);
    } else if (usable.length === 1) {
      setNodeId(usable[0].id);
    }
  }, [nodeId, nodes, defaultNodeId]);

  const destination = dest.pick?.destination ?? "";
  // A committed row's label is the field's text; while that echo stands the
  // list is UNFILTERED (the whole ledger again), because the echo is display,
  // not a search. Any keystroke releases the pick, and text becomes query.
  const pickLabel = dest.pickId !== null ? destinationOptions.find((o) => o.value === dest.pickId)?.label : undefined;
  const destinationQuery = dest.pick !== null && dest.typed === pickLabel ? "" : dest.typed;

  // Typing is only typing here (the field reports keystrokes, never echoes),
  // so an edit always releases the commitment: what the field shows is what
  // the launch would carry, never a stale pick under new text.
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

  async function submit(): Promise<void> {
    setSubmitAttempted(true);
    if (nodeId === "" || destination === "") return;
    setRefusal(null);
    try {
      const created = await launch.mutateAsync({ node: nodeId, destination });
      if (remember) {
        // The alias rides ONLY for a config-list pick (an alias token); saved
        // and recent rows already carry their own.
        save.mutate({
          node: nodeId,
          destination,
          ...(dest.pick?.aliasToken !== undefined ? { alias: dest.pick.aliasToken } : {}),
        });
      }
      void navigate({ to: "/subshells/$id", params: { id: created.subshell.id } });
    } catch (err) {
      setRefusal(sshLaunchRefusal(err, selectedNode));
    }
  }

  const machineGap =
    submitAttempted && machineRequired
      ? fieldErrorToned([{ message: "Choose a connecting machine first.", gap: true }])
      : null;

  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={DESTINATION_IDS.field}>Destination</Label>
          <DestinationField
            id={DESTINATION_IDS.field}
            describedBy={DESTINATION_IDS.disclosure}
            placeholder="Choose or type a destination"
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
            {SSH_DISCLOSURE_COPY}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor={MACHINE_IDS.field}>
            Connect from
            {machineRequired && <RequiredMark />}
          </Label>
          <SearchableSelect
            id={MACHINE_IDS.field}
            value={nodeId}
            placeholder="Choose a machine"
            options={machineOptions}
            onValueChange={(id) => id !== "" && setNodeId(id)}
          />
          {machineGap && (
            <p id={MACHINE_IDS.requirement} className={REQUIREMENT_CAPTION_CLASS}>
              {machineGap.text}
            </p>
          )}
          {refusal?.field === "machine" && (
            <p role="alert" className="text-destructive text-detail">
              {refusal.text}
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

        <Button onClick={() => void submit()} disabled={launch.isPending || destination === ""}>
          {launch.isPending ? "Connecting…" : "Connect"}
        </Button>
      </div>

      <SavedHostsSection />
    </div>
  );
}
