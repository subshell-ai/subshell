import { apiFetch, apiPost, Button, cn, errMessage } from "@internal/node-admin";
import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboard, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { NewWorkspaceDialog } from "@/components/sidebar/new-workspace-dialog";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useInvalidateWorkspaces, useWorkspaces } from "@/hooks/use-workspaces";
import { readSubshellDrag, SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";
import type { WorkspaceDetail } from "@/types/workspace";

export const Route = createFileRoute("/workspaces")({
  component: WorkspacesPage,
});

function WorkspacesPage() {
  const { data: workspaces, isLoading, isError, refetch } = useWorkspaces();
  const invalidate = useInvalidateWorkspaces();

  const [error, setError] = useState<string | null>(null);
  // Creating moved into NewWorkspaceDialog (spec 2026-09-03 sidebar-quickadd
  // §4b): the page asks, the dialog seeds panes, enters, and names inside.
  const [dialogOpen, setDialogOpen] = useState(false);
  // Card drop-target state (spec 2026-09-03 sidebar-quickadd §5d): which card
  // the payload hovers, and a transient result note (the page has no toasts).
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const noteTimerRef = useRef<number | null>(null);

  function note(msg: string) {
    setDropNote(msg);
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = window.setTimeout(() => setDropNote(null), 4000);
  }

  async function handleCardDrop(workspaceId: string, workspaceName: string, subshellId: string) {
    try {
      // The grid only carries a count, so ask: the server happily creates a
      // second pane row for one subshell (regression #13), duplicates here
      // must be refused by the client.
      const detail = await apiFetch<WorkspaceDetail>(`/api/workspaces/${workspaceId}`);
      if (detail.panes.some((p) => p.subshellId === subshellId)) {
        note(`Already on ${workspaceName}`);
        return;
      }
      await apiPost(`/api/workspaces/${workspaceId}/panes`, { subshellId });
      await invalidate();
      note(`Added to ${workspaceName}`);
    } catch (err) {
      setError(errMessage(err, "Failed to add subshell to workspace"));
    }
  }

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

      {error && <p className="text-destructive text-detail">{error}</p>}
      {dropNote && <p className="text-muted-foreground text-sm">{dropNote}</p>}

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
              className="h-auto p-0 text-detail text-inherit underline"
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
            // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drop target, not a click handler (spec 2026-09-03 §5d)
            <div
              key={w.id}
              className={cn("rounded-lg", dropTargetId === w.id && "ring-2 ring-primary/70")}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(SUBSHELL_DND_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropTargetId(w.id);
              }}
              onDragLeave={() => setDropTargetId((t) => (t === w.id ? null : t))}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes(SUBSHELL_DND_TYPE)) return;
                e.preventDefault();
                setDropTargetId(null);
                const id = readSubshellDrag(e.dataTransfer);
                if (id) void handleCardDrop(w.id, w.name, id);
              }}
            >
              <EntityCard
                to="/workspaces/$id"
                params={{ id: w.id }}
                title={w.name}
                // One definition for both trigger surfaces — the card's ⋯ here,
                // the sidebar row's right-click in app-sidebar.tsx (spec 2026-09-03).
                menu={<WorkspaceActionsMenu workspace={w} onError={setError} />}
              >
                <p>{w.subshellCount === 1 ? "1 subshell" : `${w.subshellCount} subshells`}</p>
              </EntityCard>
            </div>
          ))}
        </div>
      )}

      <NewWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </main>
  );
}
