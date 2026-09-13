import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/nodes";
import { setFetchRouter } from "@/test-setup";

/**
 * `/nodes` offers no way to add a node when the instance says non-admins may
 * not — on EVERY opener, not just the header button.
 *
 * This test exists because the pure-rule test could not catch the bug it was
 * written for: `canAddNode` was correct and shared, and the empty state still
 * offered "Add your first node" to exactly the viewer the setting targets,
 * because that call site never asked. A rule is only as good as the surfaces
 * that consult it, so the enforceable assertion is at the page: with the
 * setting off and a non-admin viewer, NOTHING here opens the add dialog.
 */
function stubApi(over: { nodes?: unknown[]; allowNodeEnrollment?: boolean; viewerIsAdmin?: boolean }) {
  // Through the harness's own seam, not by replacing `globalThis.fetch`:
  // `test-setup.ts` binds the real fetch at import and routes through this,
  // so an override installed afterwards is simply never consulted — which is
  // why the page sat at "Loading…" forever.
  setFetchRouter((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const body =
      url.pathname === "/api/settings/public"
        ? {
            allowRegistrations: false,
            allowNodeEnrollment: over.allowNodeEnrollment ?? true,
            viewerIsAdmin: over.viewerIsAdmin ?? false,
            instanceName: "t",
            emergencyLoginActive: false,
            appBaseUrl: "http://localhost:3080",
            serverVersion: "0.0.0",
          }
        : url.pathname === "/api/nodes"
          ? { nodes: over.nodes ?? [] }
          : // `SetupKeysSection` renders on this page too and does
            // `data?.keys.length` — an empty object threw and took the whole
            // route down behind an error boundary, which is why every
            // assertion here failed for a reason unrelated to gating.
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
  // Mounted under a minimal memory router the way `routeTree.gen` wires it —
  // the same shape `nodes-detail.test.tsx` uses.
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

/** Every control on this page that opens the add-node dialog. */
const addOpeners = () => [
  ...screen.queryAllByRole("button", { name: /Add node/ }),
  ...screen.queryAllByRole("button", { name: /Add your first node/ }),
];

afterEach(cleanup);

describe("/nodes add-node gating", () => {
  it("offers NO opener to a non-admin when the setting is off, with no nodes", async () => {
    const restore = stubApi({ nodes: [], allowNodeEnrollment: false, viewerIsAdmin: false });
    try {
      renderNodes();
      // The empty state is the case that shipped broken: a non-admin with no
      // node visible to them is precisely the viewer the setting targets.
      // Wait on the sentence that only appears once BOTH reads have landed,
      // so "no openers" cannot pass merely because the page is still loading.
      await waitFor(() => expect(screen.getByText(/No nodes yet/)).toBeTruthy(), { timeout: 4000 });
      expect(addOpeners()).toEqual([]);
      expect(screen.getByText(/Ask one to add a machine for you/)).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("offers one to an admin even when the setting is off", async () => {
    const restore = stubApi({ nodes: [], allowNodeEnrollment: false, viewerIsAdmin: true });
    try {
      renderNodes();
      // Wait for the LIST, not just any opener: the header button renders
      // independent of loading, so waiting on it alone would let this pass
      // while the page never finished — which is how the first version of
      // these tests looked green on a page stuck at "Loading…".
      await waitFor(() => expect(screen.getByText(/No nodes yet/)).toBeTruthy(), { timeout: 4000 });
      expect(addOpeners().length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("offers one to anyone while the setting is on", async () => {
    const restore = stubApi({ nodes: [], allowNodeEnrollment: true, viewerIsAdmin: false });
    try {
      renderNodes();
      await waitFor(() => expect(screen.getByText(/No nodes yet/)).toBeTruthy(), { timeout: 4000 });
      expect(addOpeners().length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});
