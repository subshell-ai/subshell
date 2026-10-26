import { cn } from "@internal/node-admin";
import { isPresetCrossCommReady } from "@internal/subshell-protocol";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { CopyButton } from "@/components/copy-button";
import { PresetEnabledCell } from "@/components/presets/preset-enabled-cell";
import { useTogglePresetEnabled } from "@/hooks/use-presets";
import { presetLaunchCommand } from "@/lib/launch-command";
import { canEditPreset, ownsPreset } from "@/lib/preset-access";
import type { PresetRow } from "@/types/preset";

/**
 * One preset in its agent's table: name, auto-restart, cross-agent use, enabled, and actions. The optional
 * command detail spans the columns and wraps without truncation; copying
 * still hands over the exact single-line form for pasting into a shell.
 *
 * **The command is HIDDEN until asked for** (operator's call, 2026-09-18).
 * A preset's env vars are where API keys and base URLs live, and this page
 * printed every one of them, at every preset, to anyone who could see the
 * screen — a list of presets is something you scroll past on the way
 * somewhere else, not a secret you chose to open. Revealing is per row and
 * PER VISIT: nothing is persisted, so a reload closes what was opened, which
 * is the property that makes the default worth having.
 *
 * Copy stays available while hidden, deliberately. Copying is a deliberate
 * act aimed at a clipboard the person controls; rendering is the incidental
 * exposure, and gating the one that was already intentional would only teach
 * people to reveal first and copy second.
 */
export function PresetTableRow({ preset, binary, items }: { preset: PresetRow; binary: string; items: ActionItem[] }) {
  const [shown, setShown] = useState(false);
  const commandId = useId();
  const command = presetLaunchCommand(preset.envJson, preset.flagsJson, binary);
  const toggle = useTogglePresetEnabled();
  const disabled = preset.enabled === 0;

  return (
    <>
      {/* A disabled preset stays in its owner's table, dimmed: hiding it here
      would leave no way back in. The preview and the row menu are NOT gated,
      so a parked preset can still be inspected, exported, or re-enabled. */}
      <tr className={cn("border-b align-middle last:border-0", disabled && "opacity-70")}>
        <td className="h-8 @sm:w-1/3 w-full max-w-0 py-0 pr-4">
          <button
            type="button"
            title={preset.name}
            aria-expanded={shown}
            aria-controls={commandId}
            className="flex max-w-full items-center gap-2 rounded-md text-left font-strong hover:underline"
            onClick={() => setShown((value) => !value)}
          >
            {shown ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            <span className="truncate">{preset.name}</span>
          </button>
          {!ownsPreset(preset) && (
            <p className="@2xl:hidden text-detail text-muted-foreground">
              Shared by {preset.ownerName ?? preset.userId} · {preset.access === "view" ? "View" : "Edit"}
            </p>
          )}
        </td>
        <td className="@sm:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
          {preset.restartOnExit === 1 ? "Yes" : "No"}
        </td>
        {/* Readiness uses the same opt-in, node, and directory checks as list_presets. */}
        <td className="@lg:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
          {isPresetCrossCommReady(preset) ? "Yes" : "No"}
        </td>
        <td className="@sm:table-cell hidden h-8 whitespace-nowrap py-0 pr-4">
          <PresetEnabledCell
            name={preset.name}
            enabled={!disabled}
            editable={canEditPreset(preset)}
            onToggle={(checked) => toggle.mutate({ id: preset.id, enabled: checked })}
          />
        </td>
        <td
          className="@2xl:table-cell hidden h-8 max-w-0 truncate py-0 pr-4 text-muted-foreground"
          title={preset.ownerName ?? (ownsPreset(preset) ? "You" : preset.userId)}
        >
          {preset.ownerName ?? (ownsPreset(preset) ? "You" : preset.userId)}
        </td>
        <td className="h-8 w-px py-0 text-right">
          <div className="flex justify-end gap-1">
            <CopyButton text={command} label="launch command" />
            <ActionsMenu label={preset.name} items={items} />
          </div>
        </td>
      </tr>
      {/* Unmounted rather than visually hidden: the text must not be in the
          DOM for a screenshot, a find-in-page or a devtools scroll to reach
          while the row claims it is hidden. */}
      {shown && (
        <tr className="border-b last:border-0">
          <td colSpan={6} className="max-w-0 bg-muted/40 px-4 py-2">
            <pre id={commandId} className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">
              {command}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
