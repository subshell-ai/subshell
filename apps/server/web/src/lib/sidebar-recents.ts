import type { WorkspaceRow } from "@/types/workspace";

/** A compact entry in one of the sidebar's "recent" sub-lists. */
export interface SidebarRecentLink {
  /** Route param of the target detail page */
  id: string;
  /** The entity's name, shown as the row label */
  label: string;
  /** Subshells: absolute working dir, rendered under the label. Undefined for workspaces. */
  path?: string;
}

/**
 * How many entries each sub-list shows. (Spec 2026-09-03 sidebar-quickadd §3:
 * 3 was too few to spot a session among; the nav scrolls, so 8 costs nothing
 * structurally.) Exported because the sidebar slices its own recents to this
 * number — rows render FULL entities (status dot, menu, drag), not the
 * projection, so the old `recentSubshellLinks` helper has no job left.
 */
export const RECENT_LIMIT = 8;

/**
 * The most recently touched workspaces. `/api/workspaces` comes back
 * alphabetical, so recency is derived here from `updatedAt` (ISO-8601
 * strings compare correctly). The input is not mutated.
 * @param workspaces - The caller's workspace list, or undefined while it loads
 * @returns Up to {@link RECENT_LIMIT} links, most recently updated first
 */
export function recentWorkspaceLinks(workspaces: WorkspaceRow[] | undefined): SidebarRecentLink[] {
  return [...(workspaces ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_LIMIT)
    .map((w) => ({ id: w.id, label: w.name }));
}
