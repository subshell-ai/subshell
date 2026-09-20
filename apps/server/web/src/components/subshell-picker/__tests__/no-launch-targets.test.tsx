import { describe, expect, it, mock } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NoLaunchTargets } from "@/components/subshell-picker/no-launch-targets";

/**
 * Three promises this empty state makes.
 *
 * **Every way out CLOSES what contains it.** Every caller of the launch form
 * is a dialog `QuickAddProvider` mounts above the route
 * (`routes/__root.tsx`), so a button that only navigates changes the page
 * UNDERNEATH a modal that stays up — still showing this same empty state, over
 * the very page that fixes it. The host's own button did exactly that while
 * "Add a node" did not, which made the one route out look broken to the one
 * person who could take it.
 *
 * **Each reason gets the offer that actually fixes IT.** Maintenance ends from
 * the node's card; a host nobody is granted launch access on is fixed by a
 * share, and the button that used to say "Enable on {name}" pointed at a card
 * this branch deleted.
 *
 * **It answers per MACHINE.** The component was shaped around one node — the
 * host with launching off — and said "no other machine is registered as a
 * node", which maintenance (spec 2026-09-14) made false without making it look
 * false: three healthy enrolled nodes, all in maintenance, is exactly this
 * screen.
 */
function node(overrides: Partial<Node>): Node {
  return {
    id: "n",
    name: "node",
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
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
    ...overrides,
  };
}

/** The control-plane host with no launch grant left on it. */
const LOCAL_OFF = node({ id: "local", name: "Server", kind: "local", canLaunch: false });

/** Render the empty state under a router that owns both destinations. */
async function mount(nodes: Node[]): Promise<{ onNavigate: ReturnType<typeof mock>; restore: () => void }> {
  const onNavigate = mock(() => {});
  // `canAddNode` reads public settings; an unanswered read counts as allowed,
  // so this only keeps the component off the real network.
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({})))) as unknown as typeof fetch;
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NoLaunchTargets nodes={nodes} onNavigate={onNavigate} />
      </QueryClientProvider>
    ),
  });
  const nodesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/nodes" });
  const nodeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/nodes/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([nodesRoute, nodeRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(screen.getByText("No machine can run a subshell")).toBeDefined());
  return { onNavigate, restore: () => (globalThis.fetch = original) };
}

describe("NoLaunchTargets", () => {
  it("offers SHARING — not a switch — for a host nobody is granted launch access on, and closes first", async () => {
    // "Enable on Server" pointed at `LocalLaunchCard`, which is gone: that
    // page carries the Maintenance card, and maintenance is already off here.
    // The remedy left is a share, so the button has to name one.
    const { onNavigate, restore } = await mount([LOCAL_OFF]);
    try {
      expect(screen.queryByRole("button", { name: /^Enable on/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Share Server" }));
      expect(onNavigate).toHaveBeenCalled();
    } finally {
      cleanup();
      restore();
    }
  });

  it("closes the dialog before going to the Nodes page", async () => {
    const { onNavigate, restore } = await mount([LOCAL_OFF]);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Add a node" }));
      expect(onNavigate).toHaveBeenCalled();
    } finally {
      cleanup();
      restore();
    }
  });

  it("offers the way back on a maintenance node the viewer manages — and closes first", async () => {
    const { onNavigate, restore } = await mount([node({ id: "m1", name: "shop", maintenance: true })]);
    try {
      expect(screen.getByText("shop is in maintenance.")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "End maintenance on shop" }));
      expect(onNavigate).toHaveBeenCalled();
    } finally {
      cleanup();
      restore();
    }
  });

  it("names who can end it when the viewer cannot, and offers no button that would 403", async () => {
    const { restore } = await mount([
      node({ id: "m1", name: "shop", maintenance: true, access: "view", canManage: false }),
    ]);
    try {
      expect(screen.getByText("shop is in maintenance; its owner can end it.")).toBeDefined();
      expect(screen.queryByRole("button", { name: /^End maintenance/ })).toBeNull();
    } finally {
      cleanup();
      restore();
    }
  });

  it("points at an ADMIN for the control-plane host, which has no owner", async () => {
    const { restore } = await mount([
      node({ id: "local", name: "Server", kind: "local", maintenance: true, access: "edit", canManage: false }),
    ]);
    try {
      expect(screen.getByText("Server is in maintenance; an admin can end it.")).toBeDefined();
    } finally {
      cleanup();
      restore();
    }
  });

  it("says something true about EVERY machine, not just the host", async () => {
    // The sentence this replaced — "no other machine is registered as a node"
    // — was simply false here.
    const { restore } = await mount([
      LOCAL_OFF,
      node({ id: "m1", name: "shop", maintenance: true }),
      node({ id: "a2", name: "old laptop", status: "offline" }),
    ]);
    try {
      expect(
        screen.getByText(
          "Nobody is granted launch access on Server. Share it with Everyone or with specific people to allow launching.",
        ),
      ).toBeDefined();
      expect(screen.getByText("shop is in maintenance.")).toBeDefined();
      expect(screen.getByText("old laptop is offline.")).toBeDefined();
      expect(screen.queryByText(/no other machine is registered/)).toBeNull();
    } finally {
      cleanup();
      restore();
    }
  });

  it("leads with maintenance on a machine that is also offline", async () => {
    // Waking it would not help: it would refuse the launch anyway.
    const { restore } = await mount([node({ id: "m1", name: "shop", status: "offline", maintenance: true })]);
    try {
      expect(screen.getByText("shop is in maintenance.")).toBeDefined();
      expect(screen.queryByText("shop is offline.")).toBeNull();
    } finally {
      cleanup();
      restore();
    }
  });

  it("keeps the no-nodes-at-all copy for a viewer nothing is shared with", async () => {
    const { restore } = await mount([]);
    try {
      expect(screen.getByText(/No machine is available to you/)).toBeDefined();
      expect(screen.getByRole("button", { name: "Add a node" })).toBeDefined();
    } finally {
      cleanup();
      restore();
    }
  });
});
