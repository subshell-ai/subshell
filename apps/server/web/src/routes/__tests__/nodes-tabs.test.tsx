import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/nodes";
import { setFetchRouter } from "@/test-setup";

/** The table and setup keys follow URL state, including old view links. */
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
  canRetire: true,
  canLaunch: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [],
  inventoryStale: false,
  maintenance: false,
  maintenanceAt: null,
  maintenanceSource: null,
  sshEnabled: false,
  sshWideForwards: false,
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
  it("the plain path shows the table without a tile option or setup keys", async () => {
    renderNodes();
    await waitFor(() => expect(screen.getByText("AI PC")).toBeTruthy());
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tiled view" })).toBeNull();
    expect(screen.queryByText("Each setup key enrolls one machine, valid 24 h.")).toBeNull();
  });

  it("List returns from setup keys to the default table", async () => {
    const router = renderNodes("/nodes?tab=keys");
    await screen.findByRole("button", { name: "List view" });
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "Platform" })).toBeTruthy());
    expect(screen.getByText("Linux · x64")).toBeTruthy();
    expect(router.state.location.searchStr).toBe("");
  });

  it("Setup keys shows the ledger and hides the node list; the URL carries the tab", async () => {
    const router = renderNodes();
    await waitFor(() => expect(screen.getByText("AI PC")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Setup keys" }));
    await waitFor(() => expect(screen.getByText(/Each setup key enrolls one machine/)).toBeTruthy());
    expect(screen.queryByText("AI PC")).toBeNull();
    expect(router.state.location.pathname + router.state.location.searchStr).toBe("/nodes?tab=keys");
  });

  for (const tab of ["list", "tiles"]) {
    it(`old ?tab=${tab} links show the table`, async () => {
      renderNodes(`/nodes?tab=${tab}`);
      await screen.findByRole("table");
      expect(screen.queryByRole("button", { name: "Tiled view" })).toBeNull();
    });
  }
});
