import { useId, useState } from "react";
import { NetworkPluginCard } from "@/components/networking/network-plugin-card";
import { PluginIcon } from "@/components/plugin-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NetworkRow as NetworkRowData } from "@/types/network";

/**
 * One network as a collapsed row: name, a state chip, and one button that
 * expands the card in place.
 *
 * Two surfaces use it and they differ in exactly one thing — the FRAME and
 * what opens inside it. The wizard's Network step (`full` unset) uses the
 * flat list rows `AgentRow` next door established, expanding to the compact
 * first-run card. The settings page (`full`) uses one CARD per network —
 * consistent with every other card on that page — and expands to the WHOLE
 * card inside the same frame: every field, the supervisor detail, less the
 * header this row already renders. `NetworkPluginCard` owns both bodies; the
 * two surfaces cannot answer "what can I do from here" differently because
 * there is only one answer to render.
 *
 * Nothing is visible until asked, everywhere. This replaced a wizard layout
 * that opened on an "Other networks" heading relative to nothing and two
 * numbered sudo commands (spec 2026-09-15), and a settings page that listed
 * every network pre-expanded.
 */
export function NetworkRow({ row, full = false }: { row: NetworkRowData; full?: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const chip = chipFor(row);
  // An unsupported or disabled network has nothing to configure from here and
  // the chip already says why — the only case the card's own short-circuits
  // are not reached through either surface.
  const actionable = row.supported && row.enabled;
  const head = (
    <div className={cn("flex min-h-11 items-center gap-3", full ? "px-4 py-3" : "py-2")}>
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
  );
  /* Expansion is per-row local state: several may be open at once, and with
     one plugin shipped a rule forbidding that would be a rule about nothing. */
  const body =
    open &&
    (full ? (
      <div id={bodyId}>
        <NetworkPluginCard row={row} headerless />
      </div>
    ) : (
      <div id={bodyId} className="pb-3">
        <NetworkPluginCard row={row} compact />
      </div>
    ));
  if (full) {
    return (
      <li aria-label={row.name}>
        <Card>
          {head}
          {body}
        </Card>
      </li>
    );
  }
  return (
    <li aria-label={row.name} className="border-border/60 border-b last:border-b-0">
      {head}
      {body}
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
