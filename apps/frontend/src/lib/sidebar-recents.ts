import type { SubshellView } from "@/types/subshell";
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

/** How many entries each sub-list shows. */
const RECENT_LIMIT = 3;

/**
 * The most recent subshells. The `/api/subshells` list already arrives
 * newest-first (`createdAt desc`), so this is a plain truncation.
 * @param subshells - The caller's subshell list, or undefined while it loads
 * @returns Up to {@link RECENT_LIMIT} links, newest first
 */
export function recentSubshellLinks(subshells: SubshellView[] | undefined): SidebarRecentLink[] {
  return (subshells ?? []).slice(0, RECENT_LIMIT).map((s) => ({ id: s.id, label: s.name, path: s.workingDir }));
}

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
