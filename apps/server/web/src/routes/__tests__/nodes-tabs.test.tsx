import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/nodes";
import { setFetchRouter } from "@/test-setup";

/**
 * The Nodes page is three grouped views (operator's ask, 2026-09-22): the
 * card list, a table of the same rows, and the setup-key ledger. The tab is
 * URL state with cards as the plain path, and what is on screen must follow
 * it — the test pins the wiring, because a tab group whose clicks change
 * nothing is the exact bug a Segmented control invites.
 */
const NODE = {
  id: "a1",
  name: "AI PC",
  kind: "agent",
  os: "linux",
  arch: "x64",
  hostname: "ai-pc",
  status: "online",
  lastSeenAt: null,
  agentVersion: "0.15.0",
  protocolVersion: 12,
  access: "owner",
  canManage: true,
  canLaunch: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [],
  inventoryStale: false,
  maintenance: false,
  maintenanceAt: null,
  maintenanceSource: null,
  held: null,
};

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  cleanup();
});

function renderNodes(initialPath = "/nodes") {
  setFetchRouter((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const body =
      url.pathname === "/api/settings/public"
        ? {
            allowRegistrations: false,
            allowNodeEnrollment: true,
            viewerIsAdmin: true,
            instanceName: "t",
            emergencyLoginActive: false,
            appBaseUrl: "http://localhost:3080",
            serverVersion: "0.0.0",
          }
        : url.pathname === "/api/nodes"
          ? { nodes: [NODE] }
          : { keys: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const nodesRoute = Route.update({
    id: "/nodes",
    path: "/nodes",
    getParentRoute: () => rootRoute,
  } as Parameters<typeof Route.update>[0]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([nodesRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  dispose = () => setFetchRouter(null);
  return router;
}

describe("Nodes page tabs", () => {
  it("the plain path is the card view, and the Setup keys card is NOT on it", async () => {
    renderNodes();
    await waitFor(() => expect(screen.getByText("AI PC")).toBeTruthy());
    // The card view renders the node once; the keys section is on its tab,
    // not below the list as it used to be.
    expect(screen.queryByText("Single-use enrollment credentials, valid 24 h.")).toBeNull();
  });

  it("Table switches the same rows to the column grid", async () => {
    renderNodes();
    await waitFor(() => expect(screen.getByText("AI PC")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "Platform" })).toBeTruthy());
    expect(screen.getByText("Linux · x64")).toBeTruthy();
  });

  it("Setup keys shows the ledger and hides the node list; the URL carries the tab", async () => {
    const router = renderNodes();
    await waitFor(() => expect(screen.getByText("AI PC")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Setup keys" }));
    await waitFor(() => expect(screen.getByText(/Single-use enrollment credentials/)).toBeTruthy());
    expect(screen.queryByText("AI PC")).toBeNull();
    expect(router.state.location.pathname + router.state.location.searchStr).toBe("/nodes?tab=keys");
  });

  it("arriving at ?tab=list lands on the table without a click", async () => {
    renderNodes("/nodes?tab=list");
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "Platform" })).toBeTruthy());
  });
});
