import type { Node } from "@internal/node-admin";
import { Input, Label } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { useState } from "react";
import { PromptStackSection } from "@/components/prompts/prompt-stack-section";
import {
  DIALOG_IDS,
  hideMachineField,
  isSelectable,
  type NewSubshellFormIds,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/launch-form-rules";
import { NoLaunchTargets } from "@/components/subshell-picker/no-launch-targets";
import { useLaunchFormDefaults } from "@/components/subshell-picker/use-launch-form-defaults";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";
import { RequiredMark } from "@/components/ui/required-mark";
import { WorkingDirField } from "@/components/working-dir-field";
import { type InstancePluginRow, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useSubshellsList } from "@/hooks/use-subshells";
import { isOfflineAgent } from "@/lib/node-label";
import { loadRecentPresetPicks, recordRecentPresetPick } from "@/lib/preset-recents";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import { buildAgentOptions, buildNodeOptions, launchableNodes } from "@/lib/subshell-compat";

// The pure half of this form — the value contract, the submit gate, the
// node-pick rules, the field-id sets — is `launch-form-rules.ts`; the ONE
// defaults effect and the picker's explicit apply are
// `use-launch-form-defaults.ts`. This file is the fields and their pairing.

/**
 * Agent + Preset + Node + Working directory — the form every launch path
 * renders: `/new`, the workspace dialogs, and the setup assistant's last
 * screen. State lives in the caller (so each can gate and reset its own
 * submit), this file owns the layout and the pairing (spec 2026-09-13 §5).
 *
 * The PRESET leads (operator ruling 2026-09-30): a type-to-filter list of
 * every preset — the last three picked lead under "Recently used", the rest
 * under "Presets" — and picking one RESETS the
 * form and COPIES the fields below it (agent, machine, directory, prompt),
 * each still editable, because a preset is a starting point, not a lock.
 * The reset makes the copy faithful: a value typed before the pick that
 * the preset does not name does not survive the pick. The input returns to its
 * placeholder after the pick: the row names an act ("copy this in"), not a
 * held state, so the filled form reads as a copy and edits visibly belong to
 * the launch, not to the preset. There is no create `+` on the row (ruling
 * 2026-09-30): a preset worth keeping is MADE from the whole form, by
 * "Save as preset" at its bottom, which requires a name and saves a NEW
 * row. The AGENT below it stays a direct question: options
 * are the whole plugin set, greyed never hidden (the 2026-09-02 rule,
 * unchanged; the reasons live in `lib/subshell-compat`), and the server's
 * 409 stays the authoritative backstop for anything the cached views got
 * wrong. Changing the agent clears the preset pick — the preset belongs to
 * the agent. First run hides the Preset row — a new account has zero presets
 * and the row would have nothing to offer.
 *
 * **It opens on your last launch** (operator rule, 2026-09-25): node,
 * directory, agent and preset pre-fill from the newest prior subshell, once,
 * while the form is still untouched — and choosing a preset re-applies from
 * ITS stored launch trio (spec 2026-09-29-preset-launch-fields). Both are
 * defaults, never constraints: every field stays re-pickable, and the form's
 * own arms degrade an unsafe prefill (an offline source node re-homes and
 * re-seeds the directory exactly like a machine switch; a preset that does
 * not belong to the landed agent is dropped). The wiring is
 * `use-launch-form-defaults.ts`; the selectors are `lib/launch-defaults.ts`.
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
  // the same `["presets"]` every other surface does. The Preset row lists
  // ALL of them (it leads the form and fills the agent); per-node fit is
  // the grey matrix, never a list filter.
  const { data: presetRows } = usePresets();
  const presets = presetRows ?? [];

  // The defaults read the user's most recent subshell off the ONE live-fed
  // list — no new request (spec §5).
  const { data: subshells, isPending: subshellsPending } = useSubshellsList();
  // Working-dir pre-fill seed (most recent path for the selected node);
  // when it may fire, and over what, is the defaults hook's business.
  const { data: recent } = useRecentPaths(value.nodeId);

  const { data: nodeData, isPending: nodesPending } = useNodes();
  // A well-formed registry response is `{ nodes: [...] }`; anything else
  // (an error body, an older stub) leaves the current pick untouched.
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : null;

  // The ONE effect (prior-launch node+dir → re-home → seed → agent+preset)
  // and `applyPreset`, choosing a preset's explicit act (select + prefill its
  // launch trio), which cancels a pending auto-default.
  const { applyPreset } = useLaunchFormDefaults({
    value,
    onChange,
    nodes,
    nodesPending,
    plugins,
    presetRows,
    recent,
    subshells,
    subshellsPending,
    firstRun,
  });

  const selectedNode: Node | null = (nodes ?? []).find((n) => n.id === value.nodeId) ?? null;
  const selectedAgent: InstancePluginRow | undefined = (plugins ?? []).find((p) => p.id === value.harnessId);
  const agentName = selectedAgent?.name ?? value.harnessId;
  // The section order re-renders the moment a pick lands, so the pick rides
  // state as well as the store.
  const [recentPresetIds, setRecentPresetIds] = useState<string[]>(() => loadRecentPresetPicks());
  // The blur gate for the new-preset name caption (the preset editors' rule).
  const [presetNameTouched, setPresetNameTouched] = useState(false);

  // The picker's list: the up-to-3 last-picked presets under "Recently
  // used", the rest under "Presets" (ruling 2026-09-30) - both sections
  // labelled, so no hairline is needed, and with nothing recent the single
  // list needs no header at all. There is NO "None" row: a consumed picker
  // holds nothing to un-select, the untouched form already IS "no preset",
  // and changing the agent is the documented way to drop a link a copy
  // left. A name is unique per agent, so each row carries its agent as the
  // muted reason: two "Fast" rows read Fast  Claude Code / Fast  Pi.
  const presetList: ComboboxOption[] = (() => {
    const names = new Map((plugins ?? []).map((p) => [p.id, p.name]));
    const all: ComboboxOption[] = presets.map((p) => ({
      value: p.id,
      label: p.name,
      reason: names.get(p.harnessId) ?? p.harnessId,
    }));
    const recentValues = new Set<string>();
    const recents: ComboboxOption[] = [];
    for (const id of recentPresetIds) {
      if (recents.length >= 3) break;
      const opt = all.find((o) => o.value === id);
      if (opt === undefined || recentValues.has(id)) continue;
      recents.push({ ...opt, group: "Recently used" });
      recentValues.add(id);
    }
    const rest = all.filter((o) => !recentValues.has(o.value));
    // A header only earns its keep when it SPLITS the list: if the recents
    // were everything, or there are none, one unlabelled "Presets" list is
    // the truth - not a header floating above another header.
    if (recents.length === 0) return rest;
    if (rest.length === 0) return recents.map((o) => ({ ...o, group: "Presets" }));
    return [...recents, ...rest.map((o) => ({ ...o, group: "Presets" }))];
  })();

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
      {/* Preset leads the form (operator ruling 2026-09-30): picking one
          FILLS the fields below it - agent, machine, directory, prompt -
          and everything stays editable, which is the whole point of
          filling rather than hiding. First run hides the row: a picker
          whose only offer is emptiness is a control with no choice. */}
      {!firstRun && (
        <div className="space-y-2">
          <Label htmlFor={ids.preset}>Preset</Label>
          <SearchableSelect
            id={ids.preset}
            // CONSUMED (the prompt picker's posture, now the ruling's too):
            // the pick is an action, the closed state is the placeholder,
            // nothing holds a selection. presetId still rides the launch
            // (the preset's flags and env come with it); changing the
            // agent drops it and keeps the filled fields. There is no `+`
            // beside it any more (ruling 2026-09-30): a preset you want to
            // keep is MADE from this form, at its bottom - "Save as
            // preset".
            consumed
            value=""
            placeholder="Choose a preset"
            options={presetList}
            describedBy={`${ids.preset}-hint${presets.length === 0 ? ` ${ids.preset}-empty` : ""}`}
            onValueChange={(v) => {
              if (v === "") return;
              const row = presets.find((p) => p.id === v);
              if (row === undefined) return;
              applyPreset(row);
              setRecentPresetIds(recordRecentPresetPick(row.id));
            }}
          />
          <p id={`${ids.preset}-hint`} className="text-detail text-muted-foreground">
            Picking one copies its launch settings into this form.
          </p>
          {presets.length === 0 && (
            <p id={`${ids.preset}-empty`} className="text-detail text-muted-foreground">
              No presets yet.
            </p>
          )}
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
          // The preset belongs to the agent, so a new agent drops the pick
          // (the copy's fields stay - they are the form's now).
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

      {/* Prompts (spec 2026-09-28, restated 2026-09-30): the SAME section the
          preset editors show - a divider, "Add prompts", the stack, an
          always-visible Add button. The checkbox is gone (it hid the add
          control behind a decision nobody asked for); what you stacked is
          what rides the create body, typed once the harness settles. The
          section lives HERE so all four launch surfaces get it; the clone
          dialog copies settings, never a prompt. */}
      <PromptStackSection
        blocks={value.promptBlocks}
        onBlocksChange={(promptBlocks) => onChange({ ...value, promptBlocks })}
        addButtonId={ids.prompt}
      />

      {/* Save as preset (operator ruling 2026-09-30, replacing the picker's
          `+`): the launch you just assembled can be kept, as a NEW preset
          holding the agent, machine, directory and prompts as filled here.
          The name is required exactly while the box is checked (the gold
          star, the blur caption, and `canSubmit` say so together); a
          checked box with a blank name never submits. Nothing here edits
          an existing preset - even a form copied from one saves a new row.
          Hidden on first run, where the wizard asks nothing it cannot
          show. */}
      {!firstRun && (
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id={ids.savePreset}
              checked={value.saveAsPreset === true}
              onChange={(e) => onChange({ ...value, saveAsPreset: e.target.checked })}
              className="h-4 w-4 rounded border border-input bg-background accent-primary"
            />
            <Label htmlFor={ids.savePreset}>Save as preset</Label>
          </div>
          {value.saveAsPreset === true && (
            <div className="space-y-2">
              <Label htmlFor={ids.presetName}>
                Name
                <RequiredMark />
              </Label>
              <Input
                id={ids.presetName}
                value={value.presetName ?? ""}
                onChange={(e) => onChange({ ...value, presetName: e.target.value })}
                onBlur={() => setPresetNameTouched(true)}
                placeholder="e.g. Fast model"
                aria-required
              />
              {presetNameTouched && (value.presetName ?? "").trim() === "" && (
                <p className={REQUIREMENT_CAPTION_CLASS}>A name is required.</p>
              )}
              <p className="text-detail text-muted-foreground">
                Saves a new preset with the agent, machine, directory and prompts as filled here.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
