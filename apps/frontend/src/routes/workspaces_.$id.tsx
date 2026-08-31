import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkspaceDock } from "@/components/workspace-dock";
import { WorkspaceTabs } from "@/components/workspace-tabs";
import { useIsWide } from "@/hooks/use-is-wide";
import { useWorkspace } from "@/hooks/use-workspace";

export const Route = createFileRoute("/workspaces_/$id")({
  component: WorkspaceDetailPage,
});

/**
 * The workspace detail page: the dock (wide viewports) or the tab strip
 * (narrow viewports), nothing else.
 *
 * Each presentation renders `<WorkspaceHeader>` itself, with its own
 * `<SessionPicker>` in the header's actions slot — only the presentation
 * knows how to add a pane (the dock splits, the tab strip appends), so the
 * bar is shared but the control that lives in it is not.
 */
function WorkspaceDetailPage() {
  const { id } = useParams({ from: "/workspaces_/$id" });
  const { data: detail, isLoading, refetch } = useWorkspace(id);
  const wide = useIsWide();
  // Soft-keyboard pinning is the shell's job (`__root.tsx`); `h-full` below
  // resolves against the already-pinned scroll container.

  if (isLoading) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }

  // Deliberately keyed on `!detail`, not `isError`: `useWorkspace` polls
  // every 5s, and react-query keeps the last-good `data` around when a
  // background refetch fails (a backend restart, say) — `isError` would go
  // true in that case even though `detail` is still perfectly usable. Only
  // a genuine failure on the very first load leaves `detail` undefined, so
  // that's the only case this card should show; anything else falling back
  // to this card would unmount the dock/tabs underneath, tearing down every
  // pane's terminal for a transient network blip instead of a real 404.
  if (!detail) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace not found</CardTitle>
            <CardDescription>The workspace may have been deleted.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" render={<Link to="/workspaces">Back to workspaces</Link>} />
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    // Keyed by id: navigating between workspaces reuses this route
    // component without unmounting it, and the dock seeds dockview from
    // `layout_json` only once, via `onReady` — without the key, navigating
    // to a different workspace would leave the previous workspace's layout
    // in place instead of rebuilding from the new `detail`.
    <main className="flex h-full flex-col overflow-hidden" key={detail.workspace.id}>
      {wide ? (
        <WorkspaceDock detail={detail} onRefetch={() => void refetch()} />
      ) : (
        <WorkspaceTabs detail={detail} onRefetch={() => void refetch()} />
      )}
    </main>
  );
}
