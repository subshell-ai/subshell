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
import { cleanup, render, waitFor } from "@testing-library/react";
import { WorkspaceTabs } from "@/components/workspace-tabs";
import { shouldResetForeignScroll } from "@/lib/app-scroll-pin";
import { setFetchRouter } from "@/test-setup";
import type { WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

/**
 * Regression (iPhone PWA, operator report): the phone's tab strip moved under
 * the finger, then snapped back on release. Cause: the terminal's
 * foreign-scroll pin (`subshell-terminal.tsx`'s capture-phase `onAnyScroll`,
 * decided by `shouldResetForeignScroll`) zeroes every scroller outside the
 * terminal while the terminal is engaged OR the page sits idle with focus on
 * the body — and the strip was not exempt, so its `scrollLeft` was reset by
 * its own `scroll` event mid-pan. The key bar's scroller carries
 * `data-terminal-controls-scroller` for exactly this reason; the strip now
 * carries it too.
 *
 * jsdom cannot reproduce iOS's momentum pan, so this is the strongest
 * assertion the environment allows: the DOM the REAL component mounts is fed
 * to the REAL predicate, exactly as `onAnyScroll` feeds it (an element event
 * target outside the terminal container, engaged true). An unexempt scroller
 * must still read as pinned, so the test cannot pass by exempting everything.
 */

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

const detail: WorkspaceDetail = {
  workspace: {
    id: "w1",
    name: "Strip",
    layout: null,
    subshellCount: 2,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
  },
  panes: [pane("p0", "s-1"), pane("p1", "s-2")],
};

function renderTabs(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$id",
    component: () => (
      <QueryClientProvider client={qc}>
        <WorkspaceTabs detail={detail} intent={null} claimIntent={() => false} onRefetch={async () => undefined} />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history: createMemoryHistory({ initialEntries: ["/workspaces/w1"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("WorkspaceTabs: the strip outlives the terminal's scroll pin", () => {
  afterEach(() => {
    cleanup();
    setFetchRouter(null);
  });

  it("exempts the strip's horizontal scroller from shouldResetForeignScroll", async () => {
    setFetchRouter((input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/subshells") return Promise.resolve(new Response("[]"));
      return Promise.resolve(new Response("{}", { status: 503 }));
    });
    renderTabs();

    // The strip is the scroller itself: overflow-x-auto, parent of the tabs.
    // RouterProvider paints asynchronously, so wait for the strip the way
    // `workspace-tabs-intent.test.tsx` waits for its first effect. Without
    // the exemption the query finds nothing and waitFor times out — that is
    // the failing state for this regression test.
    const strip = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-terminal-controls-scroller]");
      if (!el) throw new Error("the tab strip's scroller is not mounted yet");
      expect(document.querySelectorAll("[data-terminal-controls-scroller]").length).toBe(1);
      return el;
    });
    expect(strip.className.includes("overflow-x-auto")).toBe(true);
    expect(strip.querySelector("button")).not.toBeNull();

    // Exactly as onAnyScroll computes it for an element scroll event from
    // this scroller, on a phone with the terminal engaged (or idle-focus):
    const pinArgs = {
      touchUi: true,
      engaged: true,
      insideTerminal: false,
      terminalControls: strip.matches("[data-terminal-controls-scroller]"),
    };
    expect(shouldResetForeignScroll(pinArgs)).toBe(false);

    // The predicate is still live: a scroller WITHOUT the exemption (a random
    // foreign element) must still be reset — the test passes by exemption of
    // this one element, not by a dead predicate.
    const foreign = document.createElement("div");
    expect(
      shouldResetForeignScroll({
        touchUi: true,
        engaged: true,
        insideTerminal: false,
        terminalControls: foreign.matches("[data-terminal-controls-scroller]"),
      }),
    ).toBe(true);
  });
});
