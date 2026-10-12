import { afterEach, describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { filterNodes } from "@/lib/node-filter";
import { Route } from "@/routes/nodes";
import { setFetchRouter } from "@/test-setup";

/**
 * The Nodes toolbar narrows the table (design 2026-10-10 §B): search
 * over name/hostname, a status select, an access select, AND-composed, page
 * state only, following the home page's machine-filter precedent. A zero-match filter answers "nothing here matches", NOT
 * the enrollment question "nothing here yet", and offers one click back.
 */

/** Two rows chosen so each axis separates them: name/hostname ("AI PC" vs
 *  "Server"), status (offline vs online), access (owner vs shared/edit). */
const NODES: Node[] = [
  {
    id: "n1",
    name: "AI PC",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "theo-linux-ai",
    status: "offline",
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
    held: null,
  },
  {
    id: "n2",
    name: "Server",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "mac-builder",
    status: "online",
    lastSeenAt: null,
    agentVersion: "0.15.0",
    protocolVersion: 12,
    access: "edit",
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
    held: null,
  },
];

function stubApi() {
  // Same seam as `nodes-page-gate.test.tsx`: `test-setup.ts` binds the real
  // fetch at import and routes through this, so the stub must go in via
  // `setFetchRouter`, not by replacing `globalThis.fetch`.
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
          ? {
              nodes: filterNodes(NODES, {
                query: url.searchParams.get("q") ?? "",
                status: (url.searchParams.get("status") ?? "all") as "all" | "online" | "offline",
                access: (url.searchParams.get("access") ?? "all") as "all" | "yours" | "shared",
              }),
            }
          : // SetupKeysSection reads `data?.keys.length` — an empty object
            // here took the whole route down behind the error boundary in the
            // gate test's first draft.
            { keys: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  });
  return () => setFetchRouter(null);
}

function renderNodes() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const nodesRoute = Route.update({
    id: "/nodes",
    path: "/nodes",
    getParentRoute: () => rootRoute,
  } as Parameters<typeof Route.update>[0]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([nodesRoute]),
    history: createMemoryHistory({ initialEntries: ["/nodes"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const search = () => screen.getByRole("searchbox", { name: "Search nodes" }) as HTMLInputElement;
const typeSearch = (value: string) => fireEvent.change(search(), { target: { value } });

/** Base UI popups open on a pointer gesture and need a beat to settle —
 *  the exact shape `provider-dialog.test.tsx` drives its selects with. */
async function pickOption(triggerName: string, optionName: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }));
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
  const option = screen.getByRole("option", { name: optionName });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

afterEach(cleanup);

describe("/nodes toolbar filters", () => {
  it("search, status, and access narrow the table", async () => {
    const restore = stubApi();
    try {
      renderNodes();
      // The table is the default (no `?tab`).
      expect(await screen.findByText("AI PC")).toBeTruthy();
      expect(screen.getByText("Server")).toBeTruthy();

      typeSearch("server");
      expect(await screen.findByText("Server")).toBeTruthy();
      await waitFor(() => expect(screen.queryByText("AI PC") === null).toBe(true));

      typeSearch("");
      expect(await screen.findByText("AI PC")).toBeTruthy();

      await pickOption("Filter by status", "Offline");
      expect(await screen.findByText("AI PC")).toBeTruthy();
      await waitFor(() => expect(screen.queryByText("Server") === null).toBe(true));

      expect(screen.getByRole("columnheader", { name: "Platform" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Tiled view" })).toBeNull();

      // AND-composition: drop the status pick, keep the access one — "Server"
      // is `edit`, i.e. shared, so only it survives.
      await pickOption("Filter by status", "All status");
      await pickOption("Filter by access", "Shared");
      expect(await screen.findByText("Server")).toBeTruthy();
      await waitFor(() => expect(screen.queryByText("AI PC") === null).toBe(true));
    } finally {
      restore();
    }
  });

  it("zero matches offers Clear filters, distinct from the enrollment empty state", async () => {
    const restore = stubApi();
    try {
      renderNodes();
      expect(await screen.findByText("AI PC")).toBeTruthy();

      typeSearch("zzzzz");
      expect(await screen.findByText("No nodes match")).toBeTruthy();
      // The two states answer different questions: rows EXIST, they just
      // don't match — the enrollment card must not surface here.
      expect(screen.queryByText(/No nodes yet/)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      expect(await screen.findByText("AI PC")).toBeTruthy();
      expect(screen.getByText("Server")).toBeTruthy();
    } finally {
      restore();
    }
  });
});
