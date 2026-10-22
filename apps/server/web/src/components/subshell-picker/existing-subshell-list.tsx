import { cn, ExplainedButton, relativeElapsed } from "@internal/node-admin";
import { Check } from "lucide-react";
import type { JSX } from "react";
import { ListLoadError } from "@/components/list-load-error";
import { SubshellDot } from "@/components/subshell-dot";
import { SubshellSearch } from "@/components/subshell-search";
import { useClockTick } from "@/hooks/use-clock-tick";
import { useFilteredSubshells, useInvalidateSubshells } from "@/hooks/use-subshells";
import { ACTIVITY_TICK_MS } from "@/lib/subshell-indicator";
import { priorityRunning } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/**
 * The searchable list of subshells that can be added to a workspace — in
 * two selection modes: single-pick (the add-dialog) or checkbox multi-select
 * (the new-workspace dialog) when `selected` + `onToggle` are passed.
 *
 * This replaces three parallel dropdown submenus, which listed every subshell
 * three times with no way to search: fine for four subshells, unusable for
 * forty. It searches through the subshells API and uses the same status
 * dot beside each name as the sidebar, keeping the picker compact on phones.
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
  totalCount,
}: {
  /** Subshells not already on this workspace. */
  subshells: SubshellView[];
  /**
   * When set, only subshells running on this node are listed. The server
   * applies this explicit filter after checking visibility. Workspace
   * pickers omit it so existing subshells from every node are available.
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
  /**
   * How many subshells exist BEFORE membership filtering: the caller's
   * unfiltered list length, once the read has settled. An empty candidate
   * list with this at 0 means nothing exists anywhere, which is not the same
   * claim as "everything is already here" (operator finding 2026-10-20: the
   * new-workspace dialog told a zero-subshell instance that every subshell
   * was already on a workspace that does not exist yet). Absent means
   * unknown, and the caller keeps today's wording.
   */
  totalCount?: number;
}): JSX.Element {
  useClockTick(ACTIVITY_TICK_MS);
  const multi = selected !== undefined && onToggle !== undefined;
  const results = useFilteredSubshells(query, nodeId);
  const retry = useInvalidateSubshells();
  // Workspace membership is a local selection constraint, not a search predicate.
  const available = new Set(subshells.map((s) => s.id));
  const filtered = priorityRunning((results.data ?? []).filter((s) => available.has(s.id)));

  return (
    <div className="space-y-3">
      <SubshellSearch value={query} onChange={onQueryChange} />

      <div className="max-h-80 min-h-32 overflow-y-auto rounded-md border">
        {loadFailed || results.isError ? (
          <ListLoadError message="Couldn't load subshells." retry={retry} busy={loading || results.isFetching} />
        ) : loading || results.isLoading ? (
          <p className="p-3 text-muted-foreground text-sm">Loading subshells…</p>
        ) : subshells.length === 0 ? (
          totalCount === 0 ? (
            <p className="p-3 text-muted-foreground text-sm">
              No subshells yet. Launch one under “New subshell”, or create the workspace empty.
            </p>
          ) : (
            <p className="p-3 text-muted-foreground text-sm">
              Every subshell is already on this workspace. Create a new one instead.
            </p>
          )
        ) : filtered.length === 0 && !query.trim() ? (
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
                <ExplainedButton
                  type="button"
                  disabled={busyId != null}
                  disabledReason="Wait for the subshell to be added."
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
                    <span className="flex min-w-0 items-center gap-2">
                      <SubshellDot subshell={subshell} className="mt-0" accessible />
                      <span className="truncate font-strong text-sm">{subshell.name}</span>
                    </span>
                    <span className="block truncate font-mono text-detail text-muted-foreground">
                      {subshell.workingDir}
                    </span>
                  </span>
                  <span className="shrink-0 text-detail text-muted-foreground">{subshell.harnessId}</span>
                  <span className="shrink-0 text-detail text-muted-foreground">
                    {subshell.lastOutputAt ? relativeElapsed(subshell.lastOutputAt) : "—"}
                  </span>
                  {busyId === subshell.id && (
                    <span className="shrink-0 text-detail text-muted-foreground">Adding…</span>
                  )}
                </ExplainedButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
