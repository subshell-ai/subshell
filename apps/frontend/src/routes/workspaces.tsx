import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboard, Plus } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { NewWorkspaceDialog } from "@/components/sidebar/new-workspace-dialog";
import { Button } from "@/components/ui/button";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useWorkspaces } from "@/hooks/use-workspaces";

export const Route = createFileRoute("/workspaces")({
  component: WorkspacesPage,
});

function WorkspacesPage() {
  const { data: workspaces, isLoading, isError, refetch } = useWorkspaces();

  const [error, setError] = useState<string | null>(null);
  // Creating moved into NewWorkspaceDialog (spec 2026-09-03 sidebar-quickadd
  // §4b): the page asks, the dialog seeds panes, enters, and names inside.
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Workspaces"
        subtitle="Tiled layouts of your subshells"
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus /> New workspace
          </Button>
        }
      />

      {error && <p className="text-destructive text-sm">{error}</p>}

      {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}

      {/* A failed list load is not an empty account — say so, with a retry. */}
      {isError && (
        <ErrorBanner
          message="Couldn't load workspaces."
          className="rounded-md border"
          action={
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-inherit text-xs underline"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          }
        />
      )}

      {!isLoading && !isError && workspaces?.length === 0 && (
        <EmptyState
          icon={LayoutDashboard}
          title="No workspaces yet"
          description="Group subshells into a tiled layout to work across them at once."
          actionLabel="Create your first workspace"
          onAction={() => setDialogOpen(true)}
        />
      )}

      {(workspaces?.length ?? 0) > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-3">
          {workspaces?.map((w) => (
            <EntityCard
              key={w.id}
              to="/workspaces/$id"
              params={{ id: w.id }}
              title={w.name}
              // One definition for both trigger surfaces — the card's ⋯ here,
              // the sidebar row's right-click in app-sidebar.tsx (spec 2026-09-03).
              menu={<WorkspaceActionsMenu workspace={w} onError={setError} />}
            >
              <p>{w.subshellCount === 1 ? "1 subshell" : `${w.subshellCount} subshells`}</p>
            </EntityCard>
          ))}
        </div>
      )}

      <NewWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </main>
  );
}
