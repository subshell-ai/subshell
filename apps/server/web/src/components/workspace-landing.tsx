import { Navigate } from "@tanstack/react-router";
import { TerminalSquare } from "lucide-react";
import type { JSX } from "react";
import { DashboardPage } from "@/components/dashboard-page";
import { EmptyState } from "@/components/empty-state";
import { ListLoadError } from "@/components/list-load-error";
import { LoadingCard } from "@/components/loading-card";
import { useQuickAdd } from "@/components/quick-add";
import { useSubshellsList } from "@/hooks/use-subshells";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { lastWorkspaceId } from "@/lib/current-workspace";

/**
 * `/` is not a page so much as a direction (spec 2026-10-17): open the
 * workspace you were last in, so the app resumes where you left it and the
 * pane world reads as tabs you return to, not a list you file things into.
 *
 * The remembered id must still EXIST in the caller's list — a workspace that
 * was deleted since the visit falls through to the most
 * recently touched one, and an empty account reaches the one-button state
 * below. Choosing from the server's list rather than trusting localStorage is
 * what makes a dead id impossible to land on.
 */
export function WorkspaceLanding({ keepWorkspaceSection = false }: { keepWorkspaceSection?: boolean }): JSX.Element {
  const { data: workspaces, isLoading, isError, refetch } = useWorkspaces();
  const subshells = useSubshellsList();
  const quickAdd = useQuickAdd();

  if (isLoading) return <LoadingCard message="Opening your workspace…" />;
  // A failed read is its own answer: falling through to the empty state would
  // tell someone with six workspaces to create one (the dashboard rule keeps
  // loading, errors, and zero states distinct).
  if (isError) {
    return (
      <DashboardPage>
        <ListLoadError message="Couldn’t load your workspaces." retry={refetch} busy={false} />
      </DashboardPage>
    );
  }
  const remembered = workspaces?.find((w) => w.id === lastWorkspaceId()) ?? null;
  const target =
    remembered ??
    (workspaces && workspaces.length > 0
      ? [...workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      : null);
  if (target) return <Navigate to="/workspaces/$id" params={{ id: target.id }} replace />;

  if (subshells.isLoading) return <LoadingCard message="Loading subshells…" />;
  if (subshells.isError) {
    return (
      <DashboardPage>
        <ListLoadError message="Couldn’t load subshells." retry={subshells.refetch} busy={subshells.isFetching} />
      </DashboardPage>
    );
  }
  if (subshells.data?.length) {
    if (!keepWorkspaceSection) return <Navigate to="/subshells" replace />;
    return (
      <DashboardPage>
        <EmptyState
          icon={TerminalSquare}
          title="Open your subshells together"
          description="Choose subshells to add to a workspace."
          actionLabel="New workspace"
          onAction={() => quickAdd.openNewWorkspace()}
        />
      </DashboardPage>
    );
  }

  return (
    <DashboardPage>
      <EmptyState
        icon={TerminalSquare}
        title="No subshells yet"
        description="Start an agent or a terminal session to get going."
        actionLabel="Create your first subshell"
        onAction={() => {
          // The first pane has no window to join, and the create hook knows:
          // a launch raised with no workspace on screen opens one around it.
          quickAdd.openLaunch();
        }}
      />
    </DashboardPage>
  );
}
