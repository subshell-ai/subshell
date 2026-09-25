import type { Node } from "@internal/node-admin";
import { Button, Label } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { JSX } from "react";
import { useMemo, useState } from "react";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import {
  DIALOG_IDS,
  hideMachineField,
  isSelectable,
  launchableNodes,
  type NewSubshellFormIds,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/launch-form-rules";
import { NoLaunchTargets } from "@/components/subshell-picker/no-launch-targets";
import { useLaunchFormDefaults } from "@/components/subshell-picker/use-launch-form-defaults";
import { SearchableSelect } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkingDirField } from "@/components/working-dir-field";
import { type InstancePluginRow, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useSubshellsList } from "@/hooks/use-subshells";
import { copySettingsOptions } from "@/lib/launch-defaults";
import { isOfflineAgent } from "@/lib/node-label";
import { buildAgentOptions, buildNodeOptions } from "@/lib/subshell-compat";

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
 * The AGENT is asked first, directly — the pickers before this design were
 * harness pickers wearing a saved-configuration costume, and making the
 * preset optional deleted the seeded Default that made the row required.
 * Agent options are the whole plugin set, greyed never hidden (the 2026-09-02
 * rule, unchanged; the reasons live in `lib/subshell-compat`), and the
 * server's 409 stays the authoritative backstop for anything the cached views
 * got wrong. Preset lists only the chosen agent's presets with "None" first;
 * its `+` opens a nested create dialog with the agent locked, and a created
 * preset becomes the selection. Changing the agent resets the preset. First
 * run hides the Preset row — a new account has zero presets and the row would
 * offer only "None".
 *
 * **It opens on your last launch** (operator rule, 2026-09-25): node,
 * directory, agent and preset pre-fill from the newest prior subshell, once,
 * while the form is still untouched — and the "Copy settings from" row on top
 * applies any listed row's settings as an explicit act, after edits included.
 * Both are defaults, never constraints: every field stays re-pickable, and
 * the form's own arms degrade an unsafe copy (an offline source node re-homes
 * and re-seeds the directory exactly like a machine switch; a preset that
 * does not belong to the landed agent is dropped). The wiring is
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
  // the same `["presets"]` every other surface does. Agent-scoping stays
  // client-side (`p.harnessId === value.harnessId`); per-node fit is the
  // grey matrix, never a list filter.
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
  // and `applyCopy`, the picker's explicit act that applies over edits and
  // cancels a pending auto-default.
  const applyCopy = useLaunchFormDefaults({
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
