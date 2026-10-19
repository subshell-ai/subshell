import { subshellIdFromPath, workspaceIdFromPath } from "@/lib/route-ids";
import type { WorkspaceRow } from "@/types/workspace";

export type SidebarSection = "workspaces" | "subshells" | "settings" | "mobile" | "account";

/** Routes own the navigation context, including direct visits and browser Back. */
export function sidebarSection(path: string): SidebarSection {
  if (path === "/mobile") return "mobile";
  if (path === "/account" || path === "/preferences") return "account";
  if (
    ["/settings", "/nodes", "/presets", "/prompts"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  )
    return "settings";
  if (path === "/subshells") return "subshells";
  return "workspaces";
}

/** Never substitute a different workspace when the URL names a missing one. */
export function sidebarWorkspace(rows: WorkspaceRow[], path: string, lastId: string | null): WorkspaceRow | undefined {
  const id = workspaceIdFromPath(path);
  if (id) return rows.find((row) => row.id === id);
  const subshellId = subshellIdFromPath(path);
  const candidates = subshellId
    ? rows.filter((row) => row.panes?.some((pane) => pane.subshellId === subshellId))
    : rows;
  return (
    candidates.find((row) => row.id === lastId) ??
    [...candidates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  );
}
