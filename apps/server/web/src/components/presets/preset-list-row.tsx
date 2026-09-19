import { Link } from "@tanstack/react-router";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
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
export function PresetListRow({ preset, binary, items }: { preset: PresetRow; binary: string; items: ActionItem[] }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
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
            onClick={() => setShown((v) => !v)}
            // The name says what the PRESS does, and it names the preset:
            // a list of rows whose buttons are all called "Show command"
            // is unusable to anyone navigating by name.
            aria-label={shown ? `Hide command for ${preset.name}` : `Show command for ${preset.name}`}
            aria-expanded={shown}
          >
            {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
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
      {/* Unmounted rather than visually hidden: the text must not be in the
          DOM for a screenshot, a find-in-page or a devtools scroll to reach
          while the row claims it is hidden. */}
      {shown && (
        <pre className="whitespace-pre-wrap break-words border-t bg-muted/40 px-4 py-2 font-mono text-detail leading-relaxed">
          {command}
        </pre>
      )}
    </div>
  );
}
