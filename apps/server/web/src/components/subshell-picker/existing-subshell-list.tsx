import { Check } from "lucide-react";
import type { JSX } from "react";
import { SubshellSearch } from "@/components/subshell-search";
import { RowStatusBadges, relativeElapsed } from "@/components/subshell-status";
import { filterSubshells } from "@/lib/subshell-filter";
import { priorityRunning } from "@/lib/subshell-order";
import { cn } from "@/lib/utils";
import type { SubshellView } from "@/types/subshell";

/**
 * The searchable list of subshells that can be added to a workspace — in
 * two selection modes: single-pick (the add-dialog) or checkbox multi-select
 * (the new-workspace dialog) when `selected` + `onToggle` are passed.
 *
 * This replaces three parallel dropdown submenus, which listed every subshell
 * three times with no way to search: fine for four subshells, unusable for
 * forty. It searches with `filterSubshells` and shows status with
 * `RowStatusBadges` — the `StatusChip` state plus the `WaitingChip` "waiting
 * for you" badge, or a lone "node unreachable" badge replacing both when the
 * subshell's node is offline (spec 2026-08-31 §5.6) — the same pieces the
 * subshells page uses, so a subshell reads the same here as it does there.
 * Bell-on waiting subshells sort to the top via `priorityRunning`.
 */
export function ExistingSubshellList({
  subshells,
  nodeId,
  query,
  onQueryChange,
  loadFailed,
  loading,
  onPick,
  busyId,
  selected,
  onToggle,
}: {
  /** Subshells not already on this workspace. */
  subshells: SubshellView[];
  /**
   * When set, only subshells running on this node are listed — the dialog
   * keeps the EXISTING half coherent with the node the NEW half would
   * launch onto. Pure display filtering: the list is already visibility-
   * filtered server-side and this must never be relied on for authz.
   * Older payloads without `nodeId` are treated as `local`.
   */
  nodeId?: string;
  /** Current search text. */
  query: string;
  /** Called as the search text changes. */
  onQueryChange: (query: string) => void;
  /** True when the subshells list itself failed to load — distinct from a genuinely empty list. */
  loadFailed: boolean;
  /**
   * True while the subshells list is still loading — an empty list then says
   * nothing about the workspace, so claiming "every subshell is already here"
   * would be a lie about data the dialog hasn't seen yet.
   */
  loading: boolean;
  /** Adds the picked subshell (single-pick mode). */
  onPick?: (subshellId: string) => void;
  /** Id of the subshell currently being added, if any. */
  busyId?: string | null;
  /**
   * Multi-select mode (the new-workspace dialog, spec 2026-09-03
   * sidebar-quickadd §4b): when BOTH this and `onToggle` are present, rows
   * render as checkboxes reflecting `selected` and clicking toggles instead
   * of picking. Absent = today's single-pick rows, byte-identical.
   */
  selected?: Set<string>;
  /** Toggles a row's membership in `selected`. */
  onToggle?: (id: string) => void;
}): JSX.Element {
  const multi = selected !== undefined && onToggle !== undefined;
  const onNode = nodeId === undefined ? subshells : subshells.filter((s) => (s.nodeId ?? "local") === nodeId);
  const filtered = priorityRunning(filterSubshells(onNode, query));

  return (
    <div className="space-y-3">
      <SubshellSearch value={query} onChange={onQueryChange} />

      <div className="max-h-80 min-h-32 overflow-y-auto rounded-md border">
        {loadFailed ? (
          <p className="p-3 text-destructive text-sm">Couldn't load subshells.</p>
        ) : loading ? (
          <p className="p-3 text-muted-foreground text-sm">Loading subshells…</p>
        ) : subshells.length === 0 ? (
          <p className="p-3 text-muted-foreground text-sm">
            Every subshell is already on this workspace. Create a new one instead.
          </p>
        ) : onNode.length === 0 ? (
          <p className="p-3 text-muted-foreground text-sm">
            No subshells on this node. Use “New subshell” to launch one there, or pick a different node there to list
            those subshells.
          </p>
        ) : filtered.length === 0 ? (
          <p className="p-3 text-muted-foreground text-sm">No subshells match “{query}”.</p>
        ) : (
          <ul>
            {filtered.map((subshell) => (
              <li key={subshell.id}>
                <button
                  type="button"
                  disabled={busyId != null}
                  // A spread, not two ternary attributes: the linter cannot
                  // see a conditional `role` and would flag aria-checked as
                  // unsupported on a plain button. TS narrows via `multi`.
                  {...(multi ? { role: "checkbox" as const, "aria-checked": selected.has(subshell.id) } : {})}
                  onClick={multi ? () => onToggle(subshell.id) : () => onPick?.(subshell.id)}
                  className="flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent disabled:opacity-50"
                >
                  {multi && (
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        selected.has(subshell.id)
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input",
                      )}
                    >
                      {selected.has(subshell.id) && <Check className="h-3 w-3" />}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-sm">{subshell.name}</span>
                    <span className="block truncate font-mono text-muted-foreground text-xs">
                      {subshell.workingDir}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs">{subshell.harnessId}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {subshell.lastOutputAt ? relativeElapsed(subshell.lastOutputAt) : "—"}
                  </span>
                  <RowStatusBadges subshell={subshell} />
                  {busyId === subshell.id && <span className="shrink-0 text-muted-foreground text-xs">Adding…</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
