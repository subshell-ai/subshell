import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NODE_ENROLLMENT_OFF_COPY } from "@/lib/node-enrollment";
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

/** Every control on this page that opens the add-node dialog. A DISABLED
 *  button is not one — it cannot be pressed into opening anything — but it
 *  must exist, tooltip-wired (operator ruling 2026-09-24: show the control
 *  dead and explain it, rather than hide the feature's existence). */
const addOpeners = () =>
  [
    ...screen.queryAllByRole("button", { name: /Add node/ }),
    ...screen.queryAllByRole("button", { name: /Add your first node/ }),
  ].filter((b) => !b.hasAttribute("disabled"));

afterEach(cleanup);

describe("/nodes add-node gating", () => {
  it("shows a non-admin the button DEAD, tooltip-wired, when the setting is off", async () => {
    const restore = stubApi({ nodes: [], allowNodeEnrollment: false, viewerIsAdmin: false });
    try {
      renderNodes();
      // Wait on the DISABLED state itself (review finding M-5): "No nodes
      // yet" rides only the nodes read, while the dead button rides the
      // settings read — a slower settings stub would resolve the old gate
      // while the button was still enabled.
      let add: HTMLElement | undefined;
      await waitFor(
        () => {
          add = screen.queryByRole("button", { name: /Add node/ }) ?? undefined;
          expect(add?.hasAttribute("disabled")).toBe(true);
        },
        { timeout: 4000 },
      );
      // The tooltip lives (Base UI marks the trigger element; the popup
      // itself is hover-gated, which happy-dom cannot drive — the
      // association, not the open popup, is what this can pin). Review
      // finding I-1: the association must serve readers and tab users too,
      // so the SPAN carries the tab stop and names the describedby target.
      const trigger = add?.closest("[data-base-ui-tooltip-trigger]") as HTMLElement | null;
      expect(trigger).not.toBeNull();
      expect(trigger?.getAttribute("tabindex")).toBe("0");
      const describedBy = trigger?.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy ?? "")?.textContent).toContain("Adding nodes is turned off");
      // The touch carrier: the same sentence is VISIBLE in the empty state.
      // getAll, not get — the sr-only copy above matches the same text, and
      // a unique-match `getByText` here would pin the two-carrier design
      // accidentally rather than on purpose.
      expect(screen.getAllByText(NODE_ENROLLMENT_OFF_COPY).length).toBeGreaterThanOrEqual(2);
      // Nothing ENABLED opens the dialog, and the empty state keeps no action.
      expect(addOpeners()).toEqual([]);
      expect(screen.queryByRole("button", { name: /Add your first node/ })).toBeNull();
      // The old PERMANENT paragraph beside the header stays deleted.
      expect(screen.queryByText(/Ask one to add a machine for you/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("with rows listed too: the paragraph sentence is gone and the button stays dead", async () => {
    const restore = stubApi({
      nodes: [
        {
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
        },
      ],
      allowNodeEnrollment: false,
      viewerIsAdmin: false,
    });
    try {
      renderNodes();
      await waitFor(() => expect(screen.getByText("AI PC")).toBeTruthy(), { timeout: 4000 });
      expect(screen.queryByText(/Ask one to add a machine for you/)).toBeNull();
      // Same wait-on-the-assertion shape as the first test (M-5): with rows
      // listed, the empty-state sentence is absent, so the disabled attribute
      // is the only settings-dependent fact to gate on.
      await waitFor(
        () => expect(screen.getByRole("button", { name: /Add node/ }).hasAttribute("disabled")).toBe(true),
        { timeout: 4000 },
      );
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
