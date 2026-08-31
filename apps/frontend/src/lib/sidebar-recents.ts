import type { SessionView } from "@/types/session";
import type { WorkspaceRow } from "@/types/workspace";

/** A compact entry in one of the sidebar's "recent" sub-lists. */
export interface SidebarRecentLink {
  /** Route param of the target detail page */
  id: string;
  /** The entity's name, shown as the row label */
  label: string;
}

/** How many entries each sub-list shows. */
const RECENT_LIMIT = 3;

/**
 * The most recent sessions. The `/api/sessions` list already arrives
 * newest-first (`createdAt desc`), so this is a plain truncation.
 * @param sessions - The caller's session list, or undefined while it loads
 * @returns Up to {@link RECENT_LIMIT} links, newest first
 */
export function recentSessionLinks(sessions: SessionView[] | undefined): SidebarRecentLink[] {
  return (sessions ?? []).slice(0, RECENT_LIMIT).map((s) => ({ id: s.id, label: s.name }));
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
