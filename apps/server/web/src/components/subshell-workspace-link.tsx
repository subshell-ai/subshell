import { Link } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { useSubshellWorkspaces } from "@/hooks/use-subshell-workspaces";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * Picks the workspace this subshell's page should offer.
 *
 * A draft wins over any saved workspace: it is unnamed, invisible everywhere
 * else, and almost certainly the split the user just made — the one thing
 * this link exists to get back to. Among saved ones the most recently touched
 * wins; the API already orders by `updatedAt desc`, and this re-derives it so
 * a reordered response cannot silently change the answer.
 * @param workspaces - The caller's workspaces holding this subshell
 * @returns The workspace to link to, or null when there is none
 */
export function pickWorkspace(workspaces: WorkspaceRow[]): WorkspaceRow | null {
  const draft = workspaces.find((w) => w.draft);
  if (draft) return draft;
  let best: WorkspaceRow | null = null;
  for (const w of workspaces) {
    if (!best || w.updatedAt > best.updatedAt) best = w;
  }
  return best;
}

/**
 * "This subshell is also on a workspace" — the way back from a subshell page
 * to the split it belongs to (spec 2026-09-14 §4).
 *
 * Renders nothing when there is none, which is the common case: a subshell
 * that was never split has no workspace, and an absent control says that
 * better than a disabled one.
 */
export function SubshellWorkspaceLink({ subshellId }: { subshellId: string }): JSX.Element | null {
  const { data: workspaces } = useSubshellWorkspaces(subshellId);
  const workspace = workspaces ? pickWorkspace(workspaces) : null;
  if (!workspace) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      render={<Link to="/workspaces/$id" params={{ id: workspace.id }} />}
      aria-label={
        workspace.draft ? "Open the unsaved workspace this subshell is on" : `Open workspace ${workspace.name}`
      }
    >
      <LayoutDashboard className="h-3.5 w-3.5" />
      {workspace.draft ? (
        <span>Open unsaved workspace</span>
      ) : (
        <span className="max-w-40 truncate">In “{workspace.name}”</span>
      )}
    </Button>
  );
}
