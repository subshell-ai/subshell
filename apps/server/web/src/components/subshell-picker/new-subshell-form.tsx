import type { Node } from "@internal/node-admin";
import { Button, Label } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { PromptPickerBody } from "@/components/prompts/prompt-picker-body";
import { PromptStackList } from "@/components/prompts/prompt-stack-list";
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
import { WorkingDirField } from "@/components/working-dir-field";
import { type InstancePluginRow, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useSubshellsList } from "@/hooks/use-subshells";
import { isOfflineAgent } from "@/lib/node-label";
import { loadRecentPresetPicks, recordRecentPresetPick } from "@/lib/preset-recents";
import { movePromptBlock, removePromptBlock } from "@/lib/prompt-stack";
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
 * follow a divider, "None" exits at the bottom — and picking one COPIES the
 * fields below it (agent, machine, directory, prompt), each still editable,
 * because a preset is a starting point, not a lock. The input returns to its
 * placeholder after the pick: the row names an act ("copy this in"), not a
 * held state, so the filled form reads as a copy and edits visibly belong to
 * the launch, not to the preset. Its `+` opens a nested create dialog (the agent locked
 * when one is already chosen, asked there when not), and a created preset
 * becomes the selection. The AGENT below it stays a direct question: options
 * are the whole plugin set, greyed never hidden (the 2026-09-02 rule,
 * unchanged; the reasons live in `lib/subshell-compat`), and the server's
 * 409 stays the authoritative backstop for anything the cached views got
 * wrong. Changing the agent clears the preset pick — the preset belongs to
 * the agent. First run hides the Preset row — a new account has zero presets
 * and the row would offer only "None".
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

  // The picker's list, in the prompt picker's shape (ruling 2026-09-30):
  // the up-to-3 last-picked presets under one "Recently used" header, a
  // divider, the rest, and "None" last on its own rule - dropping the
  // preset is the row's exit, not its headline. A name is unique per agent,
  // so each row carries its agent as the muted reason: two "Fast" rows read
  // Fast  Claude Code / Fast  Pi.
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
    const rest = all
      .filter((o) => !recentValues.has(o.value))
      .map((o, i) => (recents.length > 0 && i === 0 ? { ...o, divider: true } : o));
    return [...recents, ...rest, { value: "none", label: "None", reason: "Launch without a preset", divider: true }];
  })();

  const [createPresetOpen, setCreatePresetOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

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
          whose only option is "None" is a control with no choice. */}
      {!firstRun && (
        <div className="space-y-2">
          <Label htmlFor={ids.preset}>Preset</Label>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <SearchableSelect
                id={ids.preset}
                // CONSUMED (the prompt picker's posture, now the ruling's too):
                // the pick is an action, the closed state is the placeholder,
                // nothing holds a selection. presetId still rides the launch
                // (the preset's flags and env come with it); "None" drops it
                // and keeps the filled fields.
                consumed
                value=""
                placeholder="Choose a preset"
                options={presetList}
                describedBy={`${ids.preset}-hint${presets.length === 0 ? ` ${ids.preset}-empty` : ""}`}
                onValueChange={(v) => {
                  if (v === "" || v === "none") {
                    if (v === "none") applyPreset(null);
                    return;
                  }
                  const row = presets.find((p) => p.id === v);
                  if (row === undefined) return;
                  applyPreset(row);
                  setRecentPresetIds(recordRecentPresetPick(row.id));
                }}
              />
            </div>
            <Button variant="outline" size="icon" aria-label="New preset" onClick={() => setCreatePresetOpen(true)}>
              <Plus />
            </Button>
          </div>
          <p id={`${ids.preset}-hint`} className="text-detail text-muted-foreground">
            Picking one copies its launch settings into this form.
          </p>
          {presets.length === 0 && (
            <p id={`${ids.preset}-empty`} className="text-detail text-muted-foreground">
              No presets yet.
            </p>
          )}
          {/* Mounted only while open, so every open starts from a blank form
              (clone-dialog posture). Base UI nests the dialogs natively:
              Escape closes this one and the launch dialog stays up. Unlocked
              when no agent is picked yet - the Preset row no longer waits on
              one, and the create dialog asks for the agent itself. */}
          {createPresetOpen && (
            <CreatePresetDialog
              open
              lockedHarness={value.harnessId !== "" ? value.harnessId : undefined}
              onOpenChange={(next) => !next && setCreatePresetOpen(false)}
              onCreated={(row) => {
                applyPreset(row);
                setRecentPresetIds(recordRecentPresetPick(row.id));
              }}
            />
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

      {/* Prompts (spec 2026-09-28): one checkbox when untouched, so a launch
          that does not use a prompt pays nothing in screen. Checked, the
          stack and its Add button appear; the joined text rides the create
          body's existing `prompt` field and is typed once the harness
          settles. The section lives HERE so all four launch surfaces get
          it; the clone dialog copies settings, never a prompt. */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id={ids.prompt}
            checked={value.promptEnabled}
            onChange={(e) => onChange({ ...value, promptEnabled: e.target.checked })}
            className="h-4 w-4 rounded border border-input bg-background accent-primary"
          />
          <Label htmlFor={ids.prompt}>Add a prompt</Label>
        </div>
        {value.promptEnabled && (
          <>
            {value.promptBlocks.length > 0 && (
              <PromptStackList
                blocks={value.promptBlocks}
                onReorder={(localId, dir) =>
                  onChange({ ...value, promptBlocks: movePromptBlock(value.promptBlocks, localId, dir) })
                }
                onRemove={(localId) =>
                  onChange({ ...value, promptBlocks: removePromptBlock(value.promptBlocks, localId) })
                }
              />
            )}
            {/* The picker INLINE (operator ruling 2026-09-29: the dialog-
                on-dialog-on-dialog stack read as weird; this is the same
                BODY the inject action puts on a Dialog, so "choose a
                prompt" is one component in both places). A pick lands the
                block and collapses back to the button; the half-typed
                CUSTOM text outlives the collapse on purpose (the picker's
                sessionStorage draft, durable until submitted). */}
            {pickerOpen ? (
              <div className="rounded-lg border p-3">
                <PromptPickerBody
                  surface="inline"
                  mode="multi"
                  onPick={(block) => {
                    onChange({ ...value, promptBlocks: [...value.promptBlocks, block] });
                    setPickerOpen(false);
                  }}
                  onExit={() => setPickerOpen(false)}
                />
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                <Plus /> Add prompt
              </Button>
            )}
            <p className="text-detail text-muted-foreground">Typed into the pane when the subshell starts.</p>
          </>
        )}
      </div>
    </div>
  );
}
