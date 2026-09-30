import { Button, Label, Switch } from "@internal/node-admin";
import { Plus } from "lucide-react";
import { useState } from "react";
import { PromptPickerBody } from "@/components/prompts/prompt-picker-body";
import { PromptStackList } from "@/components/prompts/prompt-stack-list";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkingDirField } from "@/components/working-dir-field";
import { useNodes } from "@/hooks/use-nodes";
import { crossCommSaveBlocked, type PresetFormValue, presetLaunchGaps } from "@/lib/preset-form";
import { movePromptBlock, removePromptBlock } from "@/lib/prompt-stack";
import type { LaunchAgent } from "@/lib/subshell-compat";
import { buildNodeOptions, launchableNodes } from "@/lib/subshell-compat";

/**
 * The preset's OPTIONAL launch defaults (spec 2026-09-29 preset-launch-fields):
 * a machine, a working directory, and a prompt stack - the same three the
 * launch form asks, in the same shapes (the prompt area works exactly like the
 * new-subshell one: the checkbox, the stack rows, the inline picker; picking
 * snapshots the text, so library edits never change what this preset launches).
 * They are hints, not locks: an explicit request at launch still wins.
 *
 * Below the trio sits the CROSS-SHELL COMMS switch (migration 0043): an agent
 * can launch the preset from its name alone only when the switch is on AND
 * all three fields hold - the section states exactly what is missing.
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
  // Same rule the launch form applies (shared since this change): launchable
  // rows, plus a maintenance window listed greyed rather than hidden.
  const nodeOptions = buildNodeOptions(launchableNodes(nodes), agent);
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedNode = nodes.find((n) => n.id === value.nodeId);
  const gaps = presetLaunchGaps(value);
  const filled = 3 - gaps.length;

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
            {nodeOptions.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled === true}>
                {o.label}
                {o.reason !== undefined && <span className="text-muted-foreground"> ({o.reason})</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-detail text-muted-foreground">
          Where subshells started from this preset run unless the launch says otherwise.
        </p>
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
      {/* Cross-shell comms (migration 0043): the readiness fact is an OPT-IN
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
          <Label htmlFor="preset-cross-comm">Cross-shell comms</Label>
        </div>
        <p className="text-detail text-muted-foreground">Enable this preset for cross-shell communication via MCP.</p>
        {crossCommSaveBlocked(value) ? (
          <p className="text-destructive text-detail">
            Missing: {gaps.join(", ")}. Complete these or switch cross-shell comms off to save.
          </p>
        ) : gaps.length > 0 ? (
          <p className="text-detail text-muted-foreground">
            {filled === 0
              ? "Requirements: a machine, a working directory, and a prompt."
              : `Requirements left: ${gaps.join(", ")}.`}
          </p>
        ) : value.crossCommEnabled ? (
          <p className="text-detail text-muted-foreground">
            Agents can launch this preset from its name alone over MCP.
          </p>
        ) : (
          <p className="text-detail text-muted-foreground">
            All requirements met: switch this on to let agents launch it by name.
          </p>
        )}
      </div>
    </div>
  );
}
