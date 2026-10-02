import { Button } from "@internal/node-admin";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { presetLaunchCommand } from "@/lib/launch-command";
import type { PresetRow } from "@/types/preset";

/** The preset's launch contribution, revealed only when the person asks. */
export function LaunchCommandPreview({ preset, binary }: { preset?: PresetRow; binary?: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      {preset && (
        <p className="text-detail text-muted-foreground">
          Settings copied from <span className="font-strong">{preset.name}</span>.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-start"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown className={expanded ? "size-4 rotate-180" : "size-4"} />
        Agent command and settings
      </Button>
      <div id={id} hidden={!expanded}>
        {expanded && (
          <div className="flex flex-col gap-2">
            {binary ? (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-detail">
                {presetLaunchCommand(preset?.envJson ?? null, preset?.flagsJson ?? null, binary)}
              </pre>
            ) : (
              <p className="text-detail text-muted-foreground">
                The command name will be resolved on the selected node.
              </p>
            )}
            {preset?.settingsJson && (
              <>
                <p className="font-strong text-detail">Agent settings</p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-detail">
                  {preset.settingsJson}
                </pre>
              </>
            )}
            <p className="text-detail text-muted-foreground">
              {preset?.restartOnExit ? "Restart on exit is enabled." : "Restart on exit is disabled."}
            </p>
            <p className="text-detail text-muted-foreground">
              This preview shows your configured environment and arguments. Subshell adds its session integrations at
              launch.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
