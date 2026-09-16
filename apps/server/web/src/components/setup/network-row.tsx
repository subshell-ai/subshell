import { useId, useState } from "react";
import { NetworkPluginCard } from "@/components/networking/network-plugin-card";
import { PluginIcon } from "@/components/plugin-icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NetworkRow as NetworkRowData } from "@/types/network";

/**
 * One network on the wizard's Network step: name, a state chip, and one
 * button that expands the full card in place.
 *
 * The same shape as `AgentRow` on the next screen, and for the same reason.
 * This step used to render every network as a full card, split into "networks
 * this machine has" and an "Other networks" disclosure — so a fresh install,
 * where the first group is empty by definition, opened on a heading relative
 * to nothing followed by two numbered sudo commands, three Docs links and a
 * Re-check button, for a step whose own framing says it is optional.
 *
 * Nothing is visible until asked. What the button reveals is
 * {@link NetworkPluginCard} in `compact` — the same component
 * `/settings/networking` renders, so the two surfaces cannot come to answer
 * "what can I do from here" differently.
 */
export function NetworkRow({ row }: { row: NetworkRowData }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const chip = chipFor(row);
  // An unsupported or disabled network has nothing to configure from here and
  // the chip already says why — the only case the card's own short-circuits
  // are not reached through this step.
  const actionable = row.supported && row.enabled;
  return (
    <li aria-label={row.name} className="border-border/60 border-b last:border-b-0">
      <div className="flex min-h-11 items-center gap-3 py-2">
        <PluginIcon pluginId={row.id} name={row.name} />
        <span className="flex-1 font-strong">{row.name}</span>
        <span className={cn("text-detail", chip.className)}>{chip.text}</span>
        {actionable && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((was) => !was)}
          >
            {/* The label says what the press does NEXT. A button stuck on
                "Configure" while the instructions are already open lies about
                it, and leaves a person no way to fold them away again. */}
            {open ? "Hide" : row.published ? "Manage" : "Configure"}
          </Button>
        )}
      </div>
      {/* The row IS the list item, so the card renders its header-less body
          only — see `compact`. Expansion is per-row local state: several may
          be open at once, and with one plugin shipped a rule forbidding that
          would be a rule about nothing. */}
      {open && (
        <div id={bodyId} className="pb-3">
          <NetworkPluginCard row={row} compact />
        </div>
      )}
    </li>
  );
}

/**
 * The state chip's text and colour for one network.
 *
 * Derived from the row in the same order {@link NetworkPluginCard} derives
 * what it renders — unsupported and disabled short-circuit before any state,
 * and an absent status means the server has not asked this host yet — so the
 * chip and the expanded card can never disagree about where a network stands.
 */
function chipFor(row: NetworkRowData): { text: string; className: string } {
  if (!row.supported) return { text: "Not available on this platform", className: "text-muted-foreground" };
  if (!row.enabled) return { text: "Disabled", className: "text-muted-foreground" };
  const state = row.status?.state;
  if (state === undefined) return { text: "Not checked yet", className: "text-muted-foreground" };
  if (state === "joined") return { text: "Joined", className: "text-success" };
  if (state === "published") return { text: "Published", className: "text-success" };
  const words: Record<string, string> = {
    "not-installed": "Not installed",
    "daemon-down": "Daemon not running",
    "needs-privilege": "Needs permission",
    "needs-login": "Not signed in",
  };
  return { text: words[state] ?? state, className: "text-muted-foreground" };
}
