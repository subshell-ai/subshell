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
import { createIntentClaim } from "@/lib/intent-claim";
import type { SplitIntent } from "@/lib/workspace-split-intent";
import { setFetchRouter } from "@/test-setup";
import type { WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

/**
 * The split intent as the tab strip consumes it (spec 2026-09-14).
 *
 * The branch under test is the one the e2e suite can never reach, because it
 * needs a RELOAD with the params still in the URL: the add already landed, the
 * detail already lists the subshell, and the effect must strip the params
 * without issuing a second `POST …/panes`. The server does not dedupe, so the
 * check lives in this client and nowhere else (regression #13).
 *
 * The dock runs the identical body behind `ready`; it is tested here rather
 * than there because dockview cannot be mounted in happy-dom, and the
 * duplicated ~20 lines are the two presentations' one real difference
 * (splitting vs appending) wrapped around the same guard.
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

function detail(subshellIds: string[]): WorkspaceDetail {
  return {
    workspace: {
      id: "w1",
      name: "Sep 14, 4:45 PM",
      draft: true,
      layout: null,
      subshellCount: subshellIds.length,
      createdAt: "2026-09-14T16:45:00.000Z",
      updatedAt: "2026-09-14T16:45:00.000Z",
    },
    panes: subshellIds.map((s, i) => pane(`p${i}`, s)),
  };
}

/** Pane-add POSTs the strip issued, by request path. */
const paneAdds: string[] = [];

function routeFetch(): void {
  setFetchRouter((input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/panes") && (init?.method ?? "GET") === "POST") {
      paneAdds.push(url.pathname);
      return Promise.resolve(new Response(JSON.stringify({ id: "p-new" })));
    }
    if (url.pathname === "/api/subshells") return Promise.resolve(new Response("[]"));
    // Refused, so the panes' terminals never reach `new WebSocket` — nothing
    // is listening in happy-dom, and the socket's error event is unhandled.
    // The strip's intent effect is the subject; live panes are not.
    if (url.pathname === "/api/auth/ws-token") return Promise.resolve(new Response("{}", { status: 503 }));
    return Promise.resolve(new Response("{}"));
  });
}

/**
 * Mounts the strip at `/workspaces/w1` with the split params in the URL, so
 * the effect's own `navigate(…, { search: {} })` is observable as the params
 * actually leaving the address.
 */
function renderTabs(opts: { detail: WorkspaceDetail; intent: SplitIntent }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const claim = createIntentClaim();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$id",
    validateSearch: (search: Record<string, unknown>) => search as { add?: string; dir?: string },
    component: () => (
      <QueryClientProvider client={qc}>
        <WorkspaceTabs
          detail={opts.detail}
          intent={opts.intent}
          claimIntent={() => claim(opts.intent)}
          onRefetch={async () => undefined}
        />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history: createMemoryHistory({ initialEntries: ["/workspaces/w1?add=s-2&dir=right"] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("WorkspaceTabs: consuming a split intent", () => {
  afterEach(() => {
    cleanup();
    setFetchRouter(null);
    paneAdds.length = 0;
  });

  it("adds nothing when the intent's subshell is already a pane, and still spends the params", async () => {
    routeFetch();
    const router = renderTabs({
      detail: detail(["s-1", "s-2"]),
      intent: { subshellId: "s-2", direction: "right" },
    });
    await waitFor(() => expect(router.state.location.searchStr).toBe(""));
    expect(paneAdds).toEqual([]);
  });

  it("adds the pane when it is genuinely missing", async () => {
    routeFetch();
    const router = renderTabs({
      detail: detail(["s-1"]),
      intent: { subshellId: "s-2", direction: "right" },
    });
    await waitFor(() => expect(paneAdds).toEqual(["/api/workspaces/w1/panes"]));
    await waitFor(() => expect(router.state.location.searchStr).toBe(""));
  });
});
