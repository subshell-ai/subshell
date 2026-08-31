import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExternalLink, LayoutDashboard, Plus, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { useInvalidateWorkspaces, useWorkspaces } from "@/hooks/use-workspaces";
import { apiFetch, errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";

export const Route = createFileRoute("/workspaces")({
  component: WorkspacesPage,
});

/** Placeholder name for a fresh workspace, e.g. `Aug 28, 4:45 PM`. */
function defaultWorkspaceName(): string {
  const stamp = new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return stamp;
}

function WorkspacesPage() {
  const navigate = useNavigate();
  const invalidate = useInvalidateWorkspaces();
  const { data: workspaces, isLoading, isError, refetch } = useWorkspaces();

  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  /**
   * Creates a workspace with a placeholder name and enters it — naming and
   * describing happen inside the workspace, where clicking the title edits
   * it in place.
   */
  async function createAndEnter() {
    setCreating(true);
    setError(null);
    try {
      const created = await apiFetch<{ id: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: defaultWorkspaceName() }),
      });
      await invalidate();
      await navigate({ to: "/workspaces/$id", params: { id: created.id } });
    } catch (err) {
      setError(errMessage(err, "Failed to create workspace"));
    } finally {
      setCreating(false);
    }
  }

  async function deleteWorkspace(id: string) {
    const ok = await confirmAction({ title: "Delete this workspace?", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await apiFetch(`/api/workspaces/${id}`, { method: "DELETE" });
      await invalidate();
    } catch (err) {
      setError(errMessage(err, "Failed to delete workspace"));
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Workspaces"
        subtitle="Tiled layouts of your sessions"
        action={
          <Button onClick={() => void createAndEnter()} disabled={creating}>
            <Plus /> {creating ? "Creating…" : "New workspace"}
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
          description="Group sessions into a tiled layout to work across them at once."
          actionLabel="Create your first workspace"
          onAction={() => void createAndEnter()}
          busy={creating}
          busyLabel="Creating…"
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
              items={[
                {
                  label: "Open",
                  icon: ExternalLink,
                  onSelect: () => void navigate({ to: "/workspaces/$id", params: { id: w.id } }),
                },
                {
                  label: "Open in new tab",
                  icon: SquareArrowOutUpRight,
                  onSelect: () => window.open(`/workspaces/${w.id}`, "_blank", "noopener,noreferrer"),
                },
                {
                  label: "Delete workspace",
                  icon: Trash2,
                  destructive: true,
                  onSelect: () => void deleteWorkspace(w.id),
                },
              ]}
            >
              <p>{w.sessionCount === 1 ? "1 session" : `${w.sessionCount} sessions`}</p>
            </EntityCard>
          ))}
        </div>
      )}
    </main>
  );
}
