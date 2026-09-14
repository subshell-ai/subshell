import { Link } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { presetLaunchCommand } from "@/lib/launch-command";
import type { PresetRow } from "@/types/preset";

/**
 * One preset in the list view: an identity row (name, restart policy,
 * actions) above the monospaced launch command the preset contributes —
 * the preset shown as what it actually does. No harness badge: the row sits
 * under its agent's own group header, which says it once. The command never
 * truncates: it wraps, and the copy button hands over the exact single-line
 * form for pasting into a shell.
 */
export function PresetListRow({ preset, binary, items }: { preset: PresetRow; binary: string; items: ActionItem[] }) {
  const [copied, setCopied] = useState(false);
  const command = presetLaunchCommand(preset.envJson, preset.flagsJson, binary);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="rounded-lg border transition-colors hover:border-primary/60">
      <div className="flex items-center gap-2 px-4 py-3">
        {/* The identity block wraps internally: when the line runs out of
            room the badge drops below the name instead of squeezing it to
            zero width (the old card's unreadable-title failure mode). The
            actions sit outside this box and never wrap. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Link
            to="/presets/$id"
            params={{ id: preset.id }}
            className="max-w-full truncate font-strong text-sm hover:underline"
            title={preset.name}
          >
            {preset.name}
          </Link>
          {preset.restartOnExit === 1 && (
            <Badge variant="secondary" className="shrink-0">
              auto-restart
            </Badge>
          )}
          {/* No description line: the name and the launch command already
              say everything a preset is, and nobody writes descriptions. */}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void copy()}
            aria-label={copied ? "Command copied" : "Copy launch command"}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <ActionsMenu label={preset.name} items={items} />
        </div>
      </div>
      <pre className="whitespace-pre-wrap break-words border-t bg-muted/40 px-4 py-2 font-mono text-xs leading-relaxed">
        {command}
      </pre>
    </div>
  );
}
