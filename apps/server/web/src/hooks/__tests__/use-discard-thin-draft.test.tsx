import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { useDiscardThinDraft } from "@/hooks/use-discard-thin-draft";
import type { SplitIntent } from "@/lib/workspace-split-intent";
import { setFetchRouter } from "@/test-setup";
import type { WorkspaceDetail, WorkspacePaneRow, WorkspaceRow } from "@/types/workspace";

/**
 * The client half of "a draft below two panes is discarded" (spec 2026-09-14).
 *
 * Two things are load-bearing here and neither is visible from the call site:
 * the `?add=` guard, without which every split discards the draft that created
 * it; and the per-WORKSPACE memory of what was already discarded, since only
 * `<main>` is keyed by workspace id — the route component itself survives a
 * workspace-to-workspace navigation, and a once-per-mount flag left the second
 * thin draft alive forever (review, 2026-09-14).
 */

function workspace(over: Partial<WorkspaceRow> & { id: string }): WorkspaceRow {
  return {
    name: "Sep 14, 4:45 PM",
    draft: true,
    layout: null,
    subshellCount: 1,
    createdAt: "2026-09-14T16:45:00.000Z",
    updatedAt: "2026-09-14T16:45:00.000Z",
    ...over,
  };
}

function pane(id: string, subshellId: string): WorkspacePaneRow {
  return {
    id,
    subshellId,
    subshellName: subshellId,
    subshellStatus: "running",
    subshellAlive: true,
    subshellExitCode: null,
    subshellWaitingSince: null,
    workingDir: "/tmp",
  };
}

/** A draft holding exactly the named subshells. */
function detail(id: string, subshellIds: string[]): WorkspaceDetail {
  return {
    workspace: workspace({ id, subshellCount: subshellIds.length }),
    panes: subshellIds.map((s, i) => pane(`p-${id}-${i}`, s)),
  };
}

/** Every DELETE the hook issued, by workspace id. */
const deleted: string[] = [];

function routeFetch(): void {
  setFetchRouter((input, init) => {
    const url = new URL(String(input), "http://localhost");
    const match = /^\/api\/workspaces\/(.+)$/.exec(url.pathname);
    if (match && (init?.method ?? "GET") === "DELETE") deleted.push(match[1] as string);
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

/**
 * Mounts the hook under a memory router carrying a `/subshells/$id` leaf, so
 * the navigation it performs is a real one this test can read back off the
 * router. Returns a `rerender` that swaps in a new detail WITHOUT unmounting —
 * which is the whole point of case (d).
 */
function renderHook(initial: { detail: WorkspaceDetail | undefined; intent: SplitIntent | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // An external store rather than a prop: TanStack Router memoizes a route's
  // component, so re-rendering the provider with a closure variable changed
  // is not guaranteed to reach the probe. A subscription is.
  let props = initial;
  const listeners = new Set<() => void>();
  function Probe() {
    const snapshot = useSyncExternalStore(
      (notify) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      () => props,
    );
    useDiscardThinDraft(snapshot.detail, snapshot.intent);
    return null;
  }
  // The probe lives in the ROOT, not in the leaf, because that is where the
  // real hook lives relative to the navigation it performs: the route
  // component outlives the workspace it was looking at, which is exactly the
  // condition the per-workspace guard has to survive.
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <Probe />
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const subshellRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/subshells/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, subshellRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  return {
    router,
    /** Feeds the SAME mounted component a new detail/intent pair. */
    update(next: { detail: WorkspaceDetail | undefined; intent: SplitIntent | null }) {
      props = next;
      act(() => {
        for (const notify of listeners) notify();
      });
    },
  };
}

describe("useDiscardThinDraft", () => {
  afterEach(() => {
    cleanup();
    setFetchRouter(null);
    deleted.length = 0;
  });

  it("sends the person back to the remaining subshell and deletes the draft", async () => {
    routeFetch();
    const { router } = renderHook({ detail: detail("w1", ["s-1"]), intent: null });
    await waitFor(() => expect(router.state.location.pathname).toBe("/subshells/s-1"));
    await waitFor(() => expect(deleted).toEqual(["w1"]));
  });

  // The guard the split flow rests on: a freshly created draft is one pane for
  // as long as its second pane is in flight, and `?add=` is exactly the
  // statement that it is. Discarding here kills every split.
  it("does nothing at all while a split intent is still in the URL", async () => {
    routeFetch();
    const { router } = renderHook({
      detail: detail("w1", ["s-1"]),
      intent: { subshellId: "s-2", direction: "right" },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe("/");
    expect(deleted).toEqual([]);
  });

  it("leaves a draft that still holds two panes alone", async () => {
    routeFetch();
    const { router } = renderHook({ detail: detail("w1", ["s-1", "s-2"]), intent: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe("/");
    expect(deleted).toEqual([]);
  });

  it("leaves a SAVED workspace alone however few panes it has", async () => {
    routeFetch();
    const saved: WorkspaceDetail = {
      workspace: workspace({ id: "w1", draft: false }),
      panes: [pane("p1", "s-1")],
    };
    const { router } = renderHook({ detail: saved, intent: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe("/");
    expect(deleted).toEqual([]);
  });

  // The regression: the route component is reused across workspace ids, so a
  // flag that only remembered "this hook has fired" left every later thin
  // draft on the instance forever.
  it("discards a SECOND thin draft reached without an unmount", async () => {
    routeFetch();
    const view = renderHook({ detail: detail("w1", ["s-1"]), intent: null });
    await waitFor(() => expect(deleted).toEqual(["w1"]));
    view.update({ detail: detail("w2", ["s-9"]), intent: null });
    await waitFor(() => expect(deleted).toEqual(["w1", "w2"]));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/subshells/s-9"));
  });

  // …and still only once each: the delete is followed by a poll that 404s, and
  // a second pass would re-navigate over whatever the person did next.
  it("does not fire twice for the same workspace", async () => {
    routeFetch();
    const view = renderHook({ detail: detail("w1", ["s-1"]), intent: null });
    await waitFor(() => expect(deleted).toEqual(["w1"]));
    view.update({ detail: detail("w1", ["s-1"]), intent: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(deleted).toEqual(["w1"]);
  });
});
