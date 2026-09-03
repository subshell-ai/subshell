import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkspaceDock } from "@/components/workspace-dock";
import { WorkspaceTabs } from "@/components/workspace-tabs";
import { useIsWide } from "@/hooks/use-is-wide";
import { useWorkspace } from "@/hooks/use-workspace";
import { ApiError } from "@/lib/api";
import { workspaceLoad } from "@/lib/workspace-load";

export const Route = createFileRoute("/workspaces_/$id")({
  component: WorkspaceDetailPage,
});

/**
 * The workspace detail page: the dock (wide viewports) or the tab strip
 * (narrow viewports), nothing else.
 *
 * Each presentation renders `<WorkspaceHeader>` itself, with its own
 * `<SubshellPicker>` in the header's actions slot — only the presentation
 * knows how to add a pane (the dock splits, the tab strip appends), so the
 * bar is shared but the control that lives in it is not.
 */
function WorkspaceDetailPage() {
  const { id } = useParams({ from: "/workspaces_/$id" });
  const { data: detail, isLoading, error, refetch } = useWorkspace(id);
  const wide = useIsWide();
  // Soft-keyboard pinning is the shell's job (`__root.tsx`); `h-full` below
  // resolves against the already-pinned scroll container.

  // Three "no detail" truths, kept apart (regression #9; the decision itself
  // is the tested lib/workspace-load.ts predicate, not inline logic).
  const load = workspaceLoad({ isLoading, detail, error });
  if (load === "loading") {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }

  if (load === "answeredError") {
    // Keyed on `!detail`: a background refetch failure keeps the last-good
    // detail, so this card is only for a first load the server answered badly.
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load this workspace</CardTitle>
            <CardDescription>
              {error instanceof ApiError ? error.message : "The server returned an error."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
            <Button variant="ghost" render={<Link to="/workspaces">Back to workspaces</Link>} />
          </CardContent>
        </Card>
      </main>
    );
  }

  // `!detail` (narrows for the render below) — this is the predicate's
  // "notFound" case: every no-answer state took the loading branch and every
  // other answered error the card above, so "deleted" is the server's own
  // word, never an outage or a 500.
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
