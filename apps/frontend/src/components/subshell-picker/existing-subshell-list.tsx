import type { JSX } from "react";
import { SubshellSearch } from "@/components/subshell-search";
import { RowStatusBadges, relativeElapsed } from "@/components/subshell-status";
import { filterSubshells } from "@/lib/subshell-filter";
import { priorityRunning } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/**
 * The searchable list of subshells that can be added to a workspace.
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
  /** Adds the picked subshell. */
  onPick: (subshellId: string) => void;
  /** Id of the subshell currently being added, if any. */
  busyId: string | null;
}): JSX.Element {
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
                  disabled={busyId !== null}
                  onClick={() => onPick(subshell.id)}
                  className="flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent disabled:opacity-50"
                >
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
