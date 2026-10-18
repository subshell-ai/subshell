import { createFileRoute, Navigate } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";
import type { JSX } from "react";
import { DashboardPage } from "@/components/dashboard-page";
import { EmptyState } from "@/components/empty-state";
import { LoadingCard } from "@/components/loading-card";
import { useQuickAdd } from "@/components/quick-add";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { lastWorkspaceId, requestCreateInNewWorkspace } from "@/lib/current-workspace";

export const Route = createFileRoute("/")({
  component: Landing,
});

/**
 * `/` is not a page so much as a direction (spec 2026-10-17): open the
 * workspace you were last in, so the app resumes where you left it and the
 * pane world reads as tabs you return to, not a list you file things into.
 *
 * The remembered id must still EXIST in the caller's list — a workspace that
 * self-retired (its last tab closed) since the visit falls through to the most
 * recently touched one, and an empty account reaches the one-button state
 * below. Choosing from the server's list rather than trusting localStorage is
 * what makes a dead id impossible to land on.
 */
function Landing(): JSX.Element {
  const { data: workspaces, isLoading } = useWorkspaces();
  const quickAdd = useQuickAdd();

  if (isLoading) return <LoadingCard message="Opening your workspace…" />;
  const remembered = workspaces?.find((w) => w.id === lastWorkspaceId()) ?? null;
  const target =
    remembered ??
    (workspaces && workspaces.length > 0
      ? [...workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      : null);
  if (target) return <Navigate to="/workspaces/$id" params={{ id: target.id }} replace />;

  return (
    <DashboardPage>
      <EmptyState
        icon={LayoutDashboard}
        title="No workspace yet"
        description="A workspace is the set of panes you're working with. Open a subshell and you're in one."
        actionLabel="New subshell"
        onAction={() => {
          // The first pane has no window to join, so this press says "make
          // one": the shared create hook files the launch into a freshly
          // named workspace, and the dialog lands there.
          requestCreateInNewWorkspace();
          quickAdd.openLaunch();
        }}
      />
    </DashboardPage>
  );
}
