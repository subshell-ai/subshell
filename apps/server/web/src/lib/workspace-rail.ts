import { RECENT_LIMIT } from "@/lib/sidebar-recents";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * The rows the rail's Workspaces branch renders, given recency-sorted
 * workspaces. Searching shows every match; the cap is for the browse view.
 * The cap never drops the workspace the page is standing IN — that branch
 * auto-expands to answer "where am I", so a row whose `updatedAt` stamp
 * aged past the limit would otherwise leave the tree with no row for the
 * workspace you are looking at (review 2026-10-17). It rides along at the
 * end, which is where its own recency puts it: older than every row the
 * slice kept.
 */
export function railWorkspaceRows(
  sorted: WorkspaceRow[],
  opts: { capped: boolean; activeId: string | null },
): WorkspaceRow[] {
  if (!opts.capped) return sorted;
  const capped = sorted.slice(0, RECENT_LIMIT);
  if (!opts.activeId || capped.some((w) => w.id === opts.activeId)) return capped;
  const active = sorted.find((w) => w.id === opts.activeId);
  return active ? [...capped, active] : capped;
}
