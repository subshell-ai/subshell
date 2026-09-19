import { ApiError, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@internal/node-admin";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";
import { WorkspaceDock } from "@/components/workspace-dock";
import { WorkspaceTabs } from "@/components/workspace-tabs";
import { useDiscardThinDraft } from "@/hooks/use-discard-thin-draft";
import { useIsWide } from "@/hooks/use-is-wide";
import { useWorkspace } from "@/hooks/use-workspace";
import { createIntentClaim } from "@/lib/intent-claim";
import { workspaceLoad } from "@/lib/workspace-load";
import { parseSplitIntent } from "@/lib/workspace-split-intent";

export const Route = createFileRoute("/workspaces_/$id")({
  // A split lands here with the subshell to add and where to put it
  // (`?add=<subshellId>&dir=<direction>`); the presentation consumes the
  // intent and strips the params. Both are optional and both are kept as
  // plain strings — `parseSplitIntent` is what decides whether they mean
  // anything, so one tested function answers it for the route and the dock.
  validateSearch: (search: Record<string, unknown>): { add?: string; dir?: string } => ({
    ...(typeof search.add === "string" && search.add ? { add: search.add } : {}),
    ...(typeof search.dir === "string" && search.dir ? { dir: search.dir } : {}),
  }),
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
  const search = Route.useSearch();
  // Memoized so the two effects that consume it (the dock's add, the
  // auto-discard below) see a stable value and run when the URL changes,
  // rather than on every poll-driven render.
  const intent = useMemo(() => parseSplitIntent(search), [search]);
  // ONE claim for both presentations. Held here rather than in each of them
  // because the viewport decides which is mounted, and crossing the breakpoint
  // mid-add swapped one for the other with the params still in the URL — two
  // fresh refs, two adds, one subshell twice (regression #13).
  const claim = useRef(createIntentClaim()).current;
  const claimIntent = useCallback(() => claim(intent), [claim, intent]);
  const { data: detail, isLoading, error, refetch } = useWorkspace(id);
  const wide = useIsWide();
  // Above every early return: an unsaved workspace that is down to one pane
  // is discarded and the person sent back to that subshell — unless a split
  // is still in flight (the `?add=` guard, see the hook).
  useDiscardThinDraft(detail, intent);
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
        <WorkspaceDock
          detail={detail}
          intent={intent}
          claimIntent={claimIntent}
          onRefetch={() => refetch().then(() => undefined)}
        />
      ) : (
        <WorkspaceTabs
          detail={detail}
          intent={intent}
          claimIntent={claimIntent}
          onRefetch={() => refetch().then(() => undefined)}
        />
      )}
    </main>
  );
}
