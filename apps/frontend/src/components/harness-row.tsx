import { HarnessInstallHelp } from "@/components/harness-install-help";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { HarnessInfo } from "@/types/harness";

/** Props for {@link HarnessRow}. */
export interface HarnessRowProps {
  /** The harness this row represents */
  harness: HarnessInfo;
  /** True while any toggle call is in flight — every row freezes together */
  pending: boolean;
  /** Last toggle failure for THIS harness (from `useHarnessToggles`) */
  error?: string;
  /** Flip this harness's enabled state */
  onToggle: (id: string, enabled: boolean) => void;
  /** Re-run server-side detection (refetch) */
  onRecheck: () => void;
}

/**
 * One harness in a management list — the row the setup wizard's Harness step
 * shows (the settings page's global harness card is gone; harness state is
 * edited per node, `/nodes/:id`). It grew out of two surfaces whose
 * toggle/error plumbing was character-identical; that logic now lives in
 * `useHarnessToggles`, and this one row carries the install help, the Enable
 * fallback, the disabled hint and the error line, which are all the same
 * shape. (The wizard once had a second, selectable "pick" variant for
 * choosing a first harness; auto-defaulted profiles removed that step, so
 * management is now the only mode.)
 */
export function HarnessRow({ harness, pending, error, onToggle, onRecheck }: HarnessRowProps) {
  return (
    // A named fieldset = role "group": the removed pick mode was a button and
    // a bare div gave e2e nothing but Tailwind classes to grab. The wizard's
    // e2e spec locates rows by this accessible name — keep both in sync.
    // (min-w-0: fieldsets default to min-width: fit-content in flex parents.)
    <fieldset aria-label={harness.name} className="min-w-0 space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <span className="text-xl">{harness.icon ?? "🤖"}</span>
        <div className="flex-1">
          <p className="font-medium">{harness.name}</p>
          <p className="text-muted-foreground text-xs">
            {harness.description}
            {harness.installed && harness.version ? ` · v${harness.version}` : ""}
          </p>
        </div>
        <span className="text-muted-foreground text-xs">
          {!harness.installed ? "not installed" : harness.enabled ? "enabled" : "disabled"}
        </span>
        {harness.installed ? (
          <Switch
            checked={harness.enabled}
            onCheckedChange={(checked) => onToggle(harness.id, checked)}
            disabled={pending}
            aria-label={`${harness.name} enabled`}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onToggle(harness.id, true)}
          >
            {pending ? "Checking…" : "Enable"}
          </Button>
        )}
      </div>
      {!harness.installed && <HarnessInstallHelp harness={harness} onRecheck={onRecheck} />}
      {harness.installed && !harness.enabled && (
        <p className="text-muted-foreground text-xs">
          Disabled — its profiles are hidden and new sessions can't start. Running sessions keep going.
        </p>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </fieldset>
  );
}
