import type { Node } from "@internal/node-admin";
import { Button, Label } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { NoLaunchTargets } from "@/components/subshell-picker/no-launch-targets";
import { SearchableSelect } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkingDirField } from "@/components/working-dir-field";
import { type InstancePluginRow, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useSubshellsList } from "@/hooks/use-subshells";
import {
  copySettingsOptions,
  isUntouchedForm,
  type LaunchTemplate,
  launchTemplateFromList,
  launchTemplateFromRow,
} from "@/lib/launch-defaults";
import { isOfflineAgent } from "@/lib/node-label";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { buildAgentOptions, buildNodeOptions, defaultAgentId } from "@/lib/subshell-compat";

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
 * `buildNodeOptions`. Mirrored in mobile `src/lib/node-pick.ts`.
 */
export function isSelectable(n: Node): boolean {
  // `canLaunch` is the SERVER's answer to "may this viewer start a subshell
  // here", and the one node that can be visible without it is the
  // control-plane host nobody is granted launch access on (spec 2026-09-12).
  //
  // Maintenance is checked SEPARATELY even though the server already ANDs it
  // into `canLaunch` (spec 2026-09-14): this row is the one unlaunchable node
  // the list keeps, so a payload cached before the flip would otherwise offer
  // a launch the node itself refuses at the pane.
  return !isOfflineAgent(n) && n.canLaunch && !n.maintenance;
}

/**
 * The machines this picker LISTS — launchable, plus the one unlaunchable kind
 * worth showing.
 *
 * A host narrowed by its shares is FILTERED rather than greyed: a greyed row
 * is a choice with a reason, and "the host you were never granted" is not a
 * choice at all — the empty state below says what to do about it, once,
 * instead of every row saying it. A node in MAINTENANCE is kept and greyed
 * (spec 2026-09-14 §6), because it is a choice with a reason and a way back:
 * somebody is working on that machine, it will take subshells again, and
 * whoever manages it can end the window from its page. Hiding it would leave
 * a person hunting for a node that had simply vanished.
 */
export function launchableNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.canLaunch || n.maintenance);
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
  const sole = targets.length === 1 ? targets[0] : undefined;
  // The rule is "one possible answer, so no question" — which means the sole
  // row has to BE an answer. A host in maintenance is zero answers, not one,
  // and that screen is no longer this function's to get right: the form
  // returns `NoLaunchTargets` before it reaches here whenever nothing is
  // selectable, which covers the sole-host-in-maintenance case completely.
  // The check stays as a belt against a caller that renders the fields
  // without that gate — a form whose one field offers only a greyed row is a
  // question with no answer, and hiding it makes the dead end silent.
  return sole !== undefined && sole.kind === "local" && isSelectable(sole);
}

/**
 * The node the picker should hold once the list has loaded: keep the current
 * pick while it stays selectable; else auto-pick the SOLE remaining selectable
 * option (typically an agent when Local is gone — not a decision worth
 * forcing); else "" — an explicit choice is due (submit stays blocked until
 * it happens).
 * Pure so the fallback matrix is testable without opening a dropdown.
 * Mirrored in mobile `src/lib/node-pick.ts`.
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
  /** "Copy settings from" combobox input */
  copy: string;
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
  copy: "picker-copy",
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
 * **It opens on your last launch** (operator rule, 2026-09-25): node,
 * directory, agent and preset pre-fill from the newest prior subshell, once,
 * while the form is still untouched — and the "Copy settings from" row on top
 * applies any listed row's settings as an explicit act, after edits included.
 * Both are defaults, never constraints: every field stays re-pickable, and
 * the form's own arms degrade an unsafe copy (an offline source node re-homes
 * and re-seeds the directory exactly like a machine switch; a preset that
 * does not belong to the landed agent is dropped).
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
  // One list, one key: availability is the SERVER's store-scoped question
  // (is the agent installed+enabled on the instance), so a preset whose
  // agent runs only on ANOTHER machine is listed here too — the form reads
  // the same `["presets"]` every other surface does. Agent-scoping stays
  // client-side (`p.harnessId === value.harnessId`); per-node fit is the
  // grey matrix, never a list filter.
  const { data: presetRows } = usePresets();
  const presets = presetRows ?? [];

  // The default agent — and now the whole default launch — reads the user's
  // most recent subshell, data the ONE live-fed list already holds, so no new
  // request (spec §5; the full-settings tier is the operator rule of
  // 2026-09-25). ONE selector for both tiers, so they can never disagree
  // about which row is "recent".
  const { data: subshells, isPending: subshellsPending } = useSubshellsList();
  const recentTemplate = useMemo(() => launchTemplateFromList(subshells), [subshells]);
  // Armed once (like every pre-fill here) and consumed by the agent tier
  // below. Held in a ref, not state: it is a scheduled correction inside the
  // ONE effect, and a render that showed it would be a second UI for it.
  const pendingTemplateRef = useRef<LaunchTemplate | null>(null);

  // Working-dir pre-fill (most recent path for the selected node) — applied
  // once per mount and only while the field is empty, so it never fights the
  // caller's state or deliberate typing. A mid-mount node switch refreshes
  // the list without yanking typed/committed input.
  const { data: recent } = useRecentPaths(value.nodeId);
  const prefillDoneRef = useRef(false);
  // The node the CURRENT `workingDir` was chosen against. A directory is a
  // claim about one machine's filesystem, so when the pick moves — the
  // Machine select, or the effect's own re-home over a vanished row — the
  // held path is another machine's answer: cleared, and the per-machine
  // seed re-armed (operator report 2026-09-20: the stale path survived the
  // switch, the picker opened on it, and the person waited out a remote 404
  // before Start over was possible). Same-kind precedent: an Agent change
  // resets Preset at the control, because the value belongs to the other
  // pick. Re-filling needs no staleness gate: the recents query is keyed
  // per node, so between the switch and the new node's answer there is
  // simply no data to fill from — the machine just left cannot answer for
  // the machine arrived at.
  const dirNodeRef = useRef(value.nodeId);

  const { data: nodeData, isPending: nodesPending } = useNodes();
  // A well-formed registry response is `{ nodes: [...] }`; anything else
  // (an error body, an older stub) leaves the current pick untouched.
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : null;

  // The "Copy settings from" rows, newest first — the same live list, no
  // second source. Labels resolve against the node registry and the plugin
  // catalog when those have answered; until then the rows carry their
  // fallbacks (short id, raw slug), never a name proven by nothing.
  const copyOptions = useMemo(
    () => copySettingsOptions(subshells, nodes ?? [], plugins ?? []),
    [subshells, nodes, plugins],
  );

  const selectedNode: Node | null = (nodes ?? []).find((n) => n.id === value.nodeId) ?? null;
  const selectedAgent: InstancePluginRow | undefined = (plugins ?? []).find((p) => p.id === value.harnessId);
  const agentName = selectedAgent?.name ?? value.harnessId;
  const agentPresets = presets.filter((p) => p.harnessId === value.harnessId);

  const [createPresetOpen, setCreatePresetOpen] = useState(false);
  const queryClient = useQueryClient();

  // ONE effect for all automatic corrections (prior-launch node+dir → node
  // re-home → working-dir pre-fill → agent+preset default): composing the
  // final value once makes the old cross-effect clobbering impossible. Runs
  // only after the node list actually loads; while it loads the default
  // "local" stands (the server accepts it).
  //
  // The node pick resolves FIRST and the node-scoped defaults read the node
  // this pass HOLDS, never the render's `selectedNode` — which derives from
  // `value` and can be one pass stale: at mount for a viewer whose `local`
  // vanished, this same effect moves the pick to an agent, and defaults read
  // against the left-behind row (or null, which greys nothing) would park the
  // form on an agent that node cannot run and a directory it does not have.
  useEffect(() => {
    let next = value;
    // The full default launch (operator rule, 2026-09-25): the form's node
    // and working directory pre-fill from the newest prior subshell, once,
    // and only while the form still holds the untouched baseline. Everything
    // that makes a form touched — a Split `initialForm`, a caller seed,
    // pre-settle typing — disqualifies this tier, never the picker. The agent
    // and its preset ride the settled tier below, on this same pass. The
    // gate waits on the node list like everything else here: arming a node
    // the settled pick then re-homes away from is the ordering this effect's
    // comments exist to keep impossible.
    if (
      pendingTemplateRef.current === null &&
      recentTemplate !== null &&
      nodes !== null &&
      // First run asks nothing it cannot show: the row it would fill a preset
      // into is hidden there, and an applied-but-invisible preset is a worse
      // launch than a cold one.
      !firstRun &&
      isUntouchedForm(next, emptyNewSubshellForm())
    ) {
      pendingTemplateRef.current = recentTemplate;
      const t = recentTemplate;
      next = { ...next, nodeId: t.nodeId, workingDir: t.workingDir };
      // The copied pair belongs together: `dirNodeRef` records the machine
      // this directory is a claim about (so a real later switch still clears
      // it), and the recents seed stands aside — a copied directory outranks
      // the generic most-recent path. With no directory to copy, the seed
      // stays armed for whatever node the pick ends on.
      dirNodeRef.current = t.nodeId;
      prefillDoneRef.current = t.workingDir !== "";
    }
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
    // The machine changed between renders (user pick, or the re-home just
    // above): drop the carried-over path and re-arm the seed, so the new
    // machine's own most-recent-else-home fills when its query answers.
    if (next.nodeId !== dirNodeRef.current) {
      dirNodeRef.current = next.nodeId;
      if (next.workingDir !== "") next = { ...next, workingDir: "" };
      prefillDoneRef.current = false;
    }
    // `!nodesPending` is the other half of "the pick is SETTLED". Arming is
    // one-way, and the recents query can answer while the node list is still
    // in flight (review round 2): arming then fills the mount default's scope
    // and a later arrival that re-homes the pick cannot correct it. Once the
    // node query has SETTLED the risk is gone even if its payload was
    // unusable — an unusable list can never move the pick (the block above
    // requires a real array), so gating on `nodes !== null` instead would
    // strand the pre-fill on a degraded registry for no safety gained.
    // The list gate is the seed yielding to the copy, not a second ordering:
    // `/recent` can answer BEFORE the subshells list on a cold load (the live
    // feed has not warmed the cache yet), and a seed that filled the field
    // there would make the form touched and disqualify the auto tier for the
    // whole session — "sometimes silently doesn't open on your last launch".
    // Same gate-the-answered-not-the-value rule as the agent tier: an ERRORED
    // list has not answered, so the seed stays armed rather than guessing the
    // list is empty.
    if (!prefillDoneRef.current && !reHomed && !nodesPending && !subshellsPending && subshells !== undefined) {
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
    //
    // The subshells list must have ANSWERED before the fill fires: the fill
    // happens once (blank-only), so filling while the list is in flight
    // silently loses the recent-wins tier for the whole dialog session
    // (cross-client review, 2026-09-13). Answered-with-empty is fine —
    // recent = null and the first-usable tier stands; an ERRORED query has
    // not answered, and the fill stays armed for a later success, the same
    // gate-the-answered-not-the-value rule as the pre-fill above.
    if (
      next.harnessId === "" &&
      plugins !== undefined &&
      nodes !== null &&
      !subshellsPending &&
      subshells !== undefined
    ) {
      const heldNode = nodes.find((n) => n.id === next.nodeId) ?? null;
      const dflt = defaultAgentId(buildAgentOptions(plugins, heldNode), plugins, recentTemplate?.harnessId ?? null);
      if (dflt !== null) next = { ...next, harnessId: dflt };
      // Consume the armed template either way — one-shot like the tier it
      // rides beside. Its preset follows only when ITS agent survived the
      // usability check; a prior launch under an agent this node cannot run
      // keeps the agent fallback and loses the preset, which is the honest
      // pair. (The membership guard below re-checks every pass regardless.)
      const t = pendingTemplateRef.current;
      if (t !== null) {
        pendingTemplateRef.current = null;
        if (dflt !== null && dflt === t.harnessId && t.presetId !== null) {
          next = { ...next, presetId: t.presetId };
        }
      }
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
    // subshellsPending joins the deps the way nodesPending does: the
    // pending→ERROR transition changes no data value, and without the flag
    // this effect would never re-run to see that the gate stayed shut.
  }, [
    recent,
    nodes,
    nodesPending,
    plugins,
    presetRows,
    subshells,
    subshellsPending,
    recentTemplate,
    firstRun,
    value,
    onChange,
  ]);

  // The picker's explicit act, unlike the auto tier: it applies over any
  // edits, and it cancels a pending auto-default. The pair rides the
  // effect's existing corrections (re-home, preset guard) exactly as a Split
  // `initialForm` does. The row itself stays unselected — the copy is an
  // action, not a held value the (re-pickable) fields would then contradict.
  function applyCopy(subshellId: string): void {
    const row = Array.isArray(subshells) ? subshells.find((s) => s.id === subshellId) : undefined;
    if (row === undefined) {
      // The row died (deleted, or revoked from view) between the option
      // rendering and the click. Nothing to copy, and the option is now a
      // lie: re-ask the list so it disappears, rather than letting the press
      // do nothing twice.
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      return;
    }
    const t = launchTemplateFromRow(row);
    pendingTemplateRef.current = null;
    // Same copied-pair posture as the auto tier: the directory belongs to the
    // node it was copied with, and the recents seed stands aside for it.
    dirNodeRef.current = t.nodeId;
    prefillDoneRef.current = t.workingDir !== "";
    onChange({ harnessId: t.harnessId, presetId: t.presetId, nodeId: t.nodeId, workingDir: t.workingDir });
  }

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
  // Nothing SELECTABLE, not merely nothing listed: a machine kept in the list
  // for its reason (maintenance) is still not somewhere a subshell can start,
  // and a form whose every option is greyed asks a question with no answer.
  // The whole node list goes through, because the empty state's job is now to
  // say — per machine — what is in the way and who can move it.
  if (nodes !== null && !targets.some(isSelectable)) {
    return <NoLaunchTargets nodes={nodes} onNavigate={onLeave} />;
  }

  return (
    <div className="space-y-4">
      {/* First, because it is cause and the four fields below are effect:
          one pick fills all four, and the row returns to its placeholder the
          moment it fires. Hidden with nothing to copy (a first account, an
          unanswered list) and on the setup assistant's first launch. */}
      {!firstRun && copyOptions.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor={ids.copy}>Copy settings from</Label>
          <SearchableSelect
            id={ids.copy}
            // The consumed posture, pinned: a copy is an action, not a held
            // selection the re-pickable fields would then contradict.
            value=""
            placeholder="Recent subshell"
            options={copyOptions}
            onValueChange={(id) => id !== "" && applyCopy(id)}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={ids.agent}>Agent</Label>
        {firstRun && (
          <p className="text-detail text-muted-foreground">
            The agent CLI this subshell runs. Terminal needs nothing installed.
          </p>
        )}
        <SearchableSelect
          id={ids.agent}
          // The dead-end hints below explain THIS field; without the
          // association a screen reader announces "Agent, combobox" and
          // nothing about why every option is greyed.
          describedBy={
            [
              noAgentHere && selectedNode ? `${ids.agent}-no-agent` : "",
              noNodeHere && selectedAgent ? `${ids.agent}-no-node` : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          value={value.harnessId}
          placeholder="Choose an agent"
          options={agentOptions}
          // The preset belongs to the agent, so a new agent starts at None.
          onValueChange={(harnessId) => harnessId !== "" && onChange({ ...value, harnessId, presetId: null })}
        />
        {noAgentHere && selectedNode ? (
          <p id={`${ids.agent}-no-agent`} className="text-detail text-muted-foreground">
            {"Nothing installed on "}
            <Link to="/nodes/$id" params={{ id: selectedNode.id }} className="underline">
              {selectedNode.name}
            </Link>
            {" can run an agent. Check the node, or ask an admin to install a plugin."}
          </p>
        ) : null}
        {noNodeHere && selectedAgent ? (
          <p id={`${ids.agent}-no-node`} className="text-detail text-muted-foreground">
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
                <SelectTrigger
                  id={ids.preset}
                  // Same association as the Agent field: the lines under this
                  // select say what a preset IS here and whether this agent
                  // has any, and only `aria-describedby` puts them in the
                  // announcement.
                  aria-describedby={
                    value.harnessId !== ""
                      ? `${ids.preset}-hint${agentPresets.length === 0 ? ` ${ids.preset}-empty` : ""}`
                      : undefined
                  }
                >
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
              <p id={`${ids.preset}-hint`} className="text-detail text-muted-foreground">
                Saved flags, env vars and restart policy for {agentName}.
              </p>
              {agentPresets.length === 0 && (
                <p id={`${ids.preset}-empty`} className="text-detail text-muted-foreground">
                  No presets for {agentName} yet.
                </p>
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
            <p className="text-detail text-muted-foreground">
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
