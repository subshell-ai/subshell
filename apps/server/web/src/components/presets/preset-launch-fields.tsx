import { Button, Label, Switch } from "@internal/node-admin";
import { Plus } from "lucide-react";
import { useState } from "react";
import { PromptPickerBody } from "@/components/prompts/prompt-picker-body";
import { PromptStackList } from "@/components/prompts/prompt-stack-list";
import type { ComboboxOption } from "@/components/ui/combobox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkingDirField } from "@/components/working-dir-field";
import { useNodes } from "@/hooks/use-nodes";
import { isOfflineAgent } from "@/lib/node-label";
import { crossCommSaveBlocked, type PresetFormValue, presetLaunchGaps } from "@/lib/preset-form";
import { movePromptBlock, removePromptBlock } from "@/lib/prompt-stack";
import type { LaunchAgent } from "@/lib/subshell-compat";
import { buildNodeOptions } from "@/lib/subshell-compat";

/**
 * The preset's OPTIONAL launch defaults (spec 2026-09-29 preset-launch-fields):
 * a machine, a working directory, and a prompt stack - the same three the
 * launch form asks, in the same shapes (the prompt area works exactly like the
 * new-subshell one: the checkbox, the stack rows, the inline picker; picking
 * snapshots the text, so library edits never change what this preset launches).
 * They are hints, not locks: an explicit request at launch still wins.
 *
 * Below the trio sits the CROSS-SUBSHELL COMMS switch (migration 0043): an
 * agent can launch the preset from its name alone when the switch is on AND a
 * machine and a directory are set - the prompt is optional launch data
 * (re-ruling 2026-09-30), so it is offered here but never required.
 */
export function PresetLaunchFields({
  value,
  onChange,
  agent,
  draftScope,
}: {
  value: PresetFormValue;
  onChange: (value: PresetFormValue) => void;
  /** The selected agent plugin row; the node list greys what cannot host it. */
  agent: LaunchAgent | null;
  /** Draft namespace for the prompt picker's half-typed custom text. */
  draftScope: string;
}) {
  const { data: nodeData } = useNodes();
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : [];
  // A preset names a machine INSTANCE-scoped: a machine that is down (or in a
  // maintenance window) right now may well host this preset's launches later,
  // so this picker lists EVERY node - split into Online/Offline when both
  // kinds exist - instead of the launch form's launchable-only filter. The
  // offline rows stay selectable; the online rows keep the live greys
  // (maintenance, agent fit), because the agent question is asked now.
  const onlineOptions = buildNodeOptions(
    nodes.filter((n) => !isOfflineAgent(n)),
    agent,
  );
  const offlineOptions = buildNodeOptions(
    nodes.filter((n) => isOfflineAgent(n)),
    agent,
  ).map((o) => ({ ...o, disabled: false }));
  const nodeOptions: ComboboxOption[] = [...onlineOptions, ...offlineOptions];
  const splitGroups = onlineOptions.length > 0 && offlineOptions.length > 0;
  const renderNodeOption = (o: ComboboxOption) => (
    <SelectItem key={o.value} value={o.value} disabled={o.disabled === true}>
      {o.label}
      {o.reason !== undefined && <span className="text-muted-foreground"> ({o.reason})</span>}
    </SelectItem>
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedNode = nodes.find((n) => n.id === value.nodeId);
  const gaps = presetLaunchGaps(value);

  return (
    <div className="space-y-3">
      <p className="font-strong text-sm leading-none">Launch defaults</p>
      <div className="space-y-2">
        <Label htmlFor="preset-launch-node">Machine</Label>
        <Select
          value={value.nodeId ?? ""}
          items={[{ value: "", label: "Decide at launch" }, ...nodeOptions]}
          onValueChange={(v) => onChange({ ...value, nodeId: v === "" || v === null ? null : v })}
        >
          <SelectTrigger id="preset-launch-node">
            <SelectValue placeholder="Decide at launch" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Decide at launch</SelectItem>
            {splitGroups && (
              <>
                <SelectGroup>
                  <p className="px-2 pt-2 text-detail text-muted-foreground">Online</p>
                  {onlineOptions.map(renderNodeOption)}
                </SelectGroup>
                <SelectGroup>
                  <p className="px-2 pt-2 text-detail text-muted-foreground">Offline</p>
                  {offlineOptions.map(renderNodeOption)}
                </SelectGroup>
              </>
            )}
            {!splitGroups && nodeOptions.map(renderNodeOption)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="preset-launch-dir">Working directory</Label>
        <WorkingDirField
          id="preset-launch-dir"
          value={value.workingDir}
          onChange={(workingDir) => onChange({ ...value, workingDir })}
          placeholder="Decide at launch"
          clearOption="Decide at launch"
          nodeId={value.nodeId !== null && value.nodeId !== "local" ? value.nodeId : undefined}
          nodeName={selectedNode?.name}
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="preset-launch-prompt"
            checked={value.promptEnabled}
            onChange={(e) => onChange({ ...value, promptEnabled: e.target.checked })}
            className="h-4 w-4 rounded border border-input bg-background accent-primary"
          />
          <Label htmlFor="preset-launch-prompt">Add a prompt</Label>
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
            {pickerOpen ? (
              <div className="rounded-lg border p-3">
                <PromptPickerBody
                  surface="inline"
                  mode="multi"
                  draftScope={draftScope}
                  onPick={(block) => {
                    onChange({ ...value, promptBlocks: [...value.promptBlocks, block] });
                    setPickerOpen(false);
                  }}
                  onExit={() => setPickerOpen(false)}
                />
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                <Plus /> Add prompt
              </Button>
            )}
          </>
        )}
      </div>
      {/* Cross-subshell comms (migration 0043): the readiness fact is an OPT-IN
          switch plus the trio, not the trio alone. The switch refuses to arm
          while requirements are missing and names what is missing; once armed
          it holds the form hostage - breaking a requirement disables Save
          until the fields or the switch are fixed (`crossCommSaveBlocked`). */}
      <div className="space-y-1 border-t pt-3">
        <div className="flex items-center gap-2">
          <Switch
            id="preset-cross-comm"
            checked={value.crossCommEnabled}
            disabled={gaps.length > 0 && !value.crossCommEnabled}
            onCheckedChange={(crossCommEnabled) => onChange({ ...value, crossCommEnabled })}
          />
          <Label htmlFor="preset-cross-comm">Enable agents to create subshells with this preset</Label>
        </div>
        <p className="text-detail text-muted-foreground">
          Enables agents to create subshells with this preset using MCP.
        </p>
        {/* What is MISSING, named and listed (all amber - the app's warning
            colour, missingness worth acting on, not an error): the lead says
            the list's job - these hold the switch back. Met requirements are
            simply absent from the list. */}
        {gaps.length > 0 && (
          <>
            <p className="text-detail text-muted-foreground">
              To enable, this preset still needs
              {value.crossCommEnabled ? " (switched on, but cannot launch yet):" : ":"}
            </p>
            <ul id="preset-cross-comm-gaps" className="ml-5 list-disc space-y-0.5">
              {gaps.map((gap) => (
                <li key={gap} className="text-amber-600 text-detail dark:text-amber-400">
                  {gap === "machine" ? "A machine" : "A working directory"}
                </li>
              ))}
            </ul>
          </>
        )}
        {crossCommSaveBlocked(value) ? (
          <p className="text-destructive text-detail">Complete every item above, or switch this off, to save.</p>
        ) : gaps.length === 0 && value.crossCommEnabled ? (
          <p className="text-detail text-muted-foreground">
            Agents can launch this preset from its name alone over MCP.
          </p>
        ) : gaps.length === 0 ? (
          <p className="text-detail text-muted-foreground">
            All requirements met: switch this on to let agents launch it by name.
          </p>
        ) : null}
      </div>
    </div>
  );
}
