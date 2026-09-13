import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { NoLaunchTargets } from "@/components/subshell-picker/no-launch-targets";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkingDirField } from "@/components/working-dir-field";
import { type InstancePluginRow, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useSubshellsList } from "@/hooks/use-subshells";
import { isOfflineAgent } from "@/lib/node-label";
import { buildAgentOptions, buildNodeOptions, defaultAgentId } from "@/lib/subshell-compat";
import { sortByCreation } from "@/lib/subshell-order";
import type { Node } from "@/types/node";

/** The fields needed to launch a new subshell (spec 2026-09-13 §5). */
export interface NewSubshellFormValue {
  /** Agent (plugin) to launch — the one required choice */
  harnessId: string;
  /** Preset to launch from; null = "None", a real presetless launch */
  presetId: string | null;
  /**
   * Launch node — defaults to "local" (the control-plane host). "" means no
   * valid choice is made yet (local vanished from the list with several other
   * nodes around), which blocks submit until the user picks one.
   */
  nodeId: string;
  workingDir: string;
}

export function emptyNewSubshellForm(): NewSubshellFormValue {
  return { harnessId: "", presetId: null, workingDir: "", nodeId: "local" };
}

/** True once the form has everything the create call requires. */
export function canSubmit(value: NewSubshellFormValue): boolean {
  return Boolean(value.harnessId) && Boolean(value.workingDir.trim()) && Boolean(value.nodeId);
}

/**
 * Whether a node is pickable right now: an OFFLINE agent is shown disabled —
 * launching there 409s `NODE_OFFLINE`, and offering a target we know is down
 * would only invite a confusing failure. (The pick list can always be stale;
 * the 409 path covers the race.) Harness compatibility greys separately, via
 * `buildNodeOptions`. Mirrored in mobile `src/lib/node-anchor.ts`.
 */
function isSelectable(n: Node): boolean {
  // `canLaunch` is the SERVER's answer to "may this viewer start a subshell
  // here", and the one node that can be visible without it is the
  // control-plane host with launching switched off (spec 2026-09-12). Read as
  // `!== false` so a build talking to an older server, which omits the field,
  // behaves exactly as it did before.
  return !isOfflineAgent(n) && n.canLaunch !== false;
}

/**
 * The machines this viewer can actually launch on.
 *
 * Unlaunchable rows are FILTERED rather than greyed: a greyed row is a choice
 * with a reason, and "the host you cannot use" is not a choice at all — the
 * empty state below says what to do about it, once, instead of every row
 * saying it.
 */
export function launchableNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.canLaunch !== false);
}

/**
 * Whether to hide the machine field entirely.
 *
 * Only when the SOLE target is the control-plane host — a fresh install, where
 * the row reads "Server · darwin/arm64" and the question it answers has not
 * occurred to anyone yet (operator's call, 2026-09-12). A single AGENT node
 * keeps the field: once a second machine exists at all, where a subshell runs
 * is worth stating.
 *
 * Pure, like `pickNodeDefault`, so the matrix is testable without opening a
 * dropdown.
 */
export function hideMachineField(nodes: Node[]): boolean {
  const targets = launchableNodes(nodes);
  return targets.length === 1 && targets[0]?.kind === "local";
}

/**
 * The node the picker should hold once the list has loaded: keep the current
 * pick while it stays selectable; else auto-pick the SOLE remaining selectable
 * option (typically an agent when Local is gone — not a decision worth
 * forcing); else "" — an explicit choice is due (submit stays blocked until
 * it happens).
 * Pure so the fallback matrix is testable without opening a dropdown.
 * Mirrored in mobile `src/lib/node-anchor.ts`.
 */
export function pickNodeDefault(nodes: Node[], current: string): string {
  if (nodes.some((n) => n.id === current && isSelectable(n))) return current;
  const selectable = nodes.filter(isSelectable);
  if (selectable.length === 1) return selectable[0].id;
  return "";
}

/**
 * Element ids of the form fields, for `htmlFor`/`id` association; they anchor
 * the searchable inputs. Two sets exist and both are e2e-pinned: the default
 * `picker-*` (every launch dialog, including the one `/new` now raises) and
 * the setup assistant's `setup-*`, which is a different form on screen at a
 * different moment rather than a second spelling of this one.
 */
export interface NewSubshellFormIds {
  /** Agent combobox input */
  agent: string;
  /** Preset select trigger */
  preset: string;
  /** Working-directory input */
  workingDir: string;
  /** Node combobox input */
  node: string;
}

const DIALOG_IDS: NewSubshellFormIds = {
  agent: "picker-agent",
  preset: "picker-preset",
  workingDir: "picker-working-dir",
  node: "picker-node",
};

/**
 * Agent + Preset + Node + Working directory — the form every launch path
 * renders: `/new`, the workspace dialogs, and the setup assistant's last
 * screen. State lives in the caller (so each can gate and reset its own
 * submit), this file owns the layout and the pairing (spec 2026-09-13 §5).
 *
 * The AGENT is asked first, directly — the pickers before this design were
 * harness pickers wearing a saved-configuration costume, and making the
 * preset optional deleted the seeded Default that made the row required.
 * Agent options are the whole plugin set, greyed
 * never hidden (the 2026-09-02 rule, unchanged; the reasons live in
 * `lib/subshell-compat`), and the server's 409 stays the authoritative
 * backstop for anything the cached views got wrong. Preset lists only the
 * chosen agent's presets with "None" first; its `+` opens a nested create
 * dialog with the agent locked, and a created preset becomes the selection.
 * Changing the agent resets the preset. First run hides the Preset row — a
 * new account has zero presets and the row would offer only "None".
 *
 * **It does not ask for a name.** The server names a new subshell after its
 * start time, and the pane's own title takes over from there; naming one
 * before it exists is a decision about something the user has not seen yet.
 * Renaming stays a deliberate act on the subshell itself — "Edit title" in
 * its actions menu, which is also the title pin.
 */
export function NewSubshellForm({
  value,
  onChange,
  ids = DIALOG_IDS,
  firstRun = false,
  onLeave,
}: {
  value: NewSubshellFormValue;
  onChange: (value: NewSubshellFormValue) => void;
  /** Field element ids; defaults to the dialog's (e2e-pinned) set. */
  ids?: NewSubshellFormIds;
  /**
   * The setup assistant's first launch: the Agent gets the one hint that
   * teaches the word, and the Preset row is hidden (there are no presets yet
   * to choose between).
   */
  firstRun?: boolean;
  /**
   * Called before the nothing-to-launch state navigates away.
   *
   * A dialog caller passes its own close here: `QuickAddProvider` mounts the
   * launch and workspace dialogs above every route, so without it the page
   * changes under a modal that stays up showing this same empty state.
   */
  onLeave?: () => void;
}): JSX.Element {
  const { data: pluginData } = useInstancePlugins();
  // A well-formed catalog response is `{ plugins: [...] }`; anything else
  // (an error body, an older stub) leaves the picker empty, never broken.
  const plugins: InstancePluginRow[] | undefined = Array.isArray(pluginData?.plugins) ? pluginData.plugins : undefined;
  const { data: presetRows } = usePresets();
  const presets = presetRows ?? [];

  // The default agent reads the user's most recent subshell — data the ONE
  // SSE-fed list already holds, so no new request (spec §5).
  const { data: subshells } = useSubshellsList();
  const recentHarnessId = useMemo(() => {
    const list = Array.isArray(subshells) ? sortByCreation(subshells) : [];
    return list[0]?.harnessId ?? null;
  }, [subshells]);

  // Working-dir pre-fill (most recent path for the selected node) — applied
  // once per mount and only while the field is empty, so it never fights the
  // caller's state or deliberate typing. A mid-mount node switch refreshes
  // the list without yanking typed/committed input.
  const { data: recent } = useRecentPaths(value.nodeId);
  const prefillDoneRef = useRef(false);

  const { data: nodeData, isPending: nodesPending } = useNodes();
  // A well-formed registry response is `{ nodes: [...] }`; anything else
  // (an error body, an older stub) leaves the current pick untouched.
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : null;

  const selectedNode: Node | null = (nodes ?? []).find((n) => n.id === value.nodeId) ?? null;
  const selectedAgent: InstancePluginRow | undefined = (plugins ?? []).find((p) => p.id === value.harnessId);
  const agentName = selectedAgent?.name ?? value.harnessId;
  const agentPresets = presets.filter((p) => p.harnessId === value.harnessId);

  const [createPresetOpen, setCreatePresetOpen] = useState(false);

  // ONE effect for all automatic corrections (node re-home → working-dir
  // pre-fill → agent default): composing the final value once makes the old
  // cross-effect clobbering impossible. Runs only after the node list actually
  // loads; while it loads the default "local" stands (the server accepts it).
  //
  // The node pick resolves FIRST and the node-scoped defaults read the node
  // this pass HOLDS, never the render's `selectedNode` — which derives from
  // `value` and can be one pass stale: at mount for a viewer whose `local`
  // vanished, this same effect moves the pick to an agent, and defaults read
  // against the left-behind row (or null, which greys nothing) would park the
  // form on an agent that node cannot run and a directory it does not have.
  useEffect(() => {
    let next = value;
    if (nodes) {
      // Re-home the pick when what it pointed at vanished (e.g. an admin
      // turned off local launching).
      const pick = pickNodeDefault(nodes, next.nodeId);
      if (pick !== next.nodeId) next = { ...next, nodeId: pick };
    }
    // True while THIS pass moved the pick: the node-scoped `recent` query is
    // still the previous node's, so the directory default waits for the pass
    // that holds the final node (its query re-keys, lands, and fires here).
    const reHomed = next.nodeId !== value.nodeId;
    // `!nodesPending` is the other half of "the pick is SETTLED". Arming is
    // one-way, and the recents query can answer while the node list is still
    // in flight (review round 2): arming then fills the mount default's scope
    // and a later arrival that re-homes the pick cannot correct it. Once the
    // node query has SETTLED the risk is gone even if its payload was
    // unusable — an unusable list can never move the pick (the block above
    // requires a real array), so gating on `nodes !== null` instead would
    // strand the pre-fill on a degraded registry for no safety gained.
    if (!prefillDoneRef.current && !reHomed && !nodesPending) {
      // Most recent path, else the node's home. A fresh instance has no
      // recents at all, and an empty absolute-path box is the highest-friction
      // field in the product at the moment the user knows least about it.
      // Gate on the query having ANSWERED, not on a value being present:
      // keying off a path alone left the flag unset forever on a node with no
      // recents, so a later unrelated render could still fire the pre-fill.
      // (An errored query has not answered — the flag stays unarmed and a
      // later retry of the query can still pre-fill, which is the point.)
      const fallback = recent?.paths[0]?.path ?? recent?.home ?? "";
      if (recent !== undefined) {
        prefillDoneRef.current = true;
        if (fallback && next.workingDir === "") next = { ...next, workingDir: fallback };
      }
    }
    // Default agent, when the user has not chosen one. Reads the same disabled
    // set the dropdown renders — computed against the row this pass holds, so
    // even a same-pass re-home cannot select an agent the server would refuse.
    // Only ever fills a blank; the "None" preset state needs no default.
    if (next.harnessId === "" && plugins !== undefined && nodes !== null) {
      const heldNode = nodes.find((n) => n.id === next.nodeId) ?? null;
      const dflt = defaultAgentId(buildAgentOptions(plugins, heldNode), plugins, recentHarnessId);
      if (dflt !== null) next = { ...next, harnessId: dflt };
    }
    // The one guard: a preset belongs to exactly one agent. (Agent changes
    // reset the preset at the control; this catches a row that vanished from
    // under a held pick.)
    if (next.presetId !== null && presetRows !== undefined) {
      const held = presetRows.find((p) => p.id === next.presetId);
      if (held === undefined || held.harnessId !== next.harnessId) next = { ...next, presetId: null };
    }
    if (next !== value) onChange(next);
    // nodesPending is a dep in its own right: a pending→ERROR transition
    // changes no data value, and without the flag the settling would never
    // re-run the effect that waits on it.
  }, [recent, nodes, nodesPending, plugins, presetRows, recentHarnessId, value, onChange]);

  const targets = launchableNodes(nodes ?? []);
  const agentOptions = buildAgentOptions(plugins ?? [], selectedNode);
  // An unmade pick ("" ) never matches a row id, so selectedNode is already
  // null there — nothing extra to guard.
  const nodeOptions = buildNodeOptions(targets, selectedAgent ?? null);

  // Honest dead-ends (spec §1): the pick stands, the pair cannot — say what
  // to fix and link there. Gate on LOADED, not non-empty: a loaded-zero list
  // is exactly the dead-end the hint names, while a still-loading one
  // (undefined/null) stays quiet — `every` on empty options is vacuously
  // true, so the loaded checks are load-bearing. Never while a side is
  // unchosen, and never for an offline agent: the row reasons already say
  // "node offline", so "nothing installed there" would misdiagnose a down
  // host as an empty one.
  const noAgentHere =
    nodes !== null &&
    selectedNode !== null &&
    plugins !== undefined &&
    !isOfflineAgent(selectedNode) &&
    agentOptions.every((o) => o.disabled);
  const noNodeHere = nodes !== null && selectedAgent !== undefined && nodeOptions.every((o) => o.disabled);

  // Nowhere to launch: the form has no question to ask, so it asks none and
  // says what to do instead. The caller's submit is already dead — `canSubmit`
  // needs a node id and `pickNodeDefault` leaves it empty when nothing is
  // selectable — so no caller has to learn about this state.
  if (nodes !== null && targets.length === 0) {
    return <NoLaunchTargets local={(nodes ?? []).find((n) => n.kind === "local") ?? null} onNavigate={onLeave} />;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={ids.agent}>Agent</Label>
        {firstRun && (
          <p className="text-muted-foreground text-xs">
            The agent CLI this subshell runs. Terminal needs nothing installed.
          </p>
        )}
        <SearchableSelect
          id={ids.agent}
          value={value.harnessId}
          placeholder="Choose an agent"
          options={agentOptions}
          // The preset belongs to the agent, so a new agent starts at None.
          onValueChange={(harnessId) => harnessId !== "" && onChange({ ...value, harnessId, presetId: null })}
        />
        {noAgentHere && selectedNode ? (
          <p className="text-muted-foreground text-xs">
            {"Nothing installed on "}
            <Link to="/nodes/$id" params={{ id: selectedNode.id }} className="underline">
              {selectedNode.name}
            </Link>
            {" can run an agent. Check the node, or ask an admin to install a plugin."}
          </p>
        ) : null}
        {noNodeHere && selectedAgent ? (
          <p className="text-muted-foreground text-xs">
            {`No available node can run ${agentName}. `}
            <Link to="/nodes" className="underline">
              Check your nodes
            </Link>
            .
          </p>
        ) : null}
      </div>

      {/* First run hides the row entirely: a new account has zero presets, and
          a picker whose only option is "None" is a control with no choice. */}
      {!firstRun && (
        <div className="space-y-2">
          <Label htmlFor={ids.preset}>Preset</Label>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                // "none" is the picker sentinel for "no preset" — the form
                // state keeps null and the wire omits presetId (see toSubshellCreateBody).
                value={value.presetId ?? "none"}
                onValueChange={(v) => v !== null && onChange({ ...value, presetId: v === "none" ? null : v })}
                // Base UI's Value prints the raw value without this map;
                // labels must match the item texts below exactly.
                items={[{ value: "none", label: "None" }, ...agentPresets.map((p) => ({ value: p.id, label: p.name }))]}
              >
                <SelectTrigger id={ids.preset}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {agentPresets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label="New preset"
              disabled={value.harnessId === ""}
              onClick={() => setCreatePresetOpen(true)}
            >
              <Plus />
            </Button>
          </div>
          {value.harnessId !== "" && (
            <>
              <p className="text-muted-foreground text-xs">Saved flags, env vars and restart policy for {agentName}.</p>
              {agentPresets.length === 0 && (
                <p className="text-muted-foreground text-xs">No presets for {agentName} yet.</p>
              )}
            </>
          )}
          {/* Mounted only while open, so every open starts from a blank form
              (clone-dialog posture). Base UI nests the dialogs natively:
              Escape closes this one and the launch dialog stays up. */}
          {createPresetOpen && value.harnessId !== "" && (
            <CreatePresetDialog
              open
              lockedHarness={value.harnessId}
              onOpenChange={(next) => !next && setCreatePresetOpen(false)}
              onCreated={(row) => onChange({ ...value, presetId: row.id })}
            />
          )}
        </div>
      )}

      {/* Hidden when the host is the only place it could run: a picker with
          one option is a control that cannot be used, and on a fresh install
          it is also the first jargon this product says to anyone. */}
      {!hideMachineField(nodes ?? []) && (
        <div className="space-y-2">
          <Label htmlFor={ids.node}>{firstRun ? "Machine" : "Node"}</Label>
          {firstRun && (
            <p className="text-muted-foreground text-xs">
              Where this subshell runs. You can add other machines as nodes later.
            </p>
          )}
          <SearchableSelect
            id={ids.node}
            value={value.nodeId}
            placeholder="Choose a node"
            options={nodeOptions}
            onValueChange={(nodeId) => nodeId !== "" && onChange({ ...value, nodeId })}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={ids.workingDir}>Working directory</Label>
        <WorkingDirField
          id={ids.workingDir}
          value={value.workingDir}
          onChange={(workingDir) => onChange({ ...value, workingDir })}
          // The picker browses the machine this subshell will start on — the
          // same node the recents pre-fill is scoped to. `local` rides the
          // request as an omitted param (byte-identical local browse).
          nodeId={value.nodeId !== "local" ? value.nodeId : undefined}
          nodeName={selectedNode?.name}
        />
      </div>
    </div>
  );
}
