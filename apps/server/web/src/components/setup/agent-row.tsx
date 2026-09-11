import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { HarnessInstallHelp } from "@/components/harness-install-help";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HarnessInfo } from "@/types/harness";

/**
 * One agent on the Add an Agent screen (spec 2026-09-11 § 6.2): name, a
 * detection chip, and when not found an Install button (where installing
 * from here exists) plus a collapsed How to install. No switch, no
 * description, no timestamp: first run asks what is here, not plugin
 * management, which lives in Settings → Plugins.
 */
export function AgentRow({
  harness,
  onInstall,
  installing = false,
}: {
  harness: HarnessInfo;
  onInstall?: (id: string) => void;
  installing?: boolean;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const chip = chipFor(harness);
  return (
    <li aria-label={harness.name} className="border-border/60 border-b last:border-b-0">
      <div className="flex min-h-11 items-center gap-3 py-2">
        <span aria-hidden className="text-lg">
          {harness.icon ?? "🤖"}
        </span>
        <span className="flex-1 font-medium">{harness.name}</span>
        <span className={cn("text-xs", chip.className)}>{chip.text}</span>
        {!harness.installed && onInstall && (
          <Button size="sm" disabled={installing} onClick={() => onInstall(harness.id)}>
            {installing ? "Installing…" : "Install"}
          </Button>
        )}
        {!harness.installed && (
          <Button variant="ghost" size="sm" aria-expanded={helpOpen} onClick={() => setHelpOpen((v) => !v)}>
            How to install
            <ChevronDown aria-hidden className={cn("ml-1 size-3.5 transition-transform", helpOpen && "rotate-180")} />
          </Button>
        )}
      </div>
      {helpOpen && !harness.installed && (
        <div className="pb-3 pl-9">
          <HarnessInstallHelp harness={harness} />
        </div>
      )}
    </li>
  );
}

/** The detection chip's text and colour for one harness. */
function chipFor(h: HarnessInfo): { text: string; className: string } {
  if (h.installed) return { text: h.version ? `Detected · v${h.version}` : "Detected", className: "text-success" };
  if (h.reason === "override-invalid" && h.envOverride) {
    return { text: `Check ${h.envOverride}`, className: "text-warning" };
  }
  return { text: "Not found", className: "text-muted-foreground" };
}
