import { afterEach, describe, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeSectionNav } from "@/components/nodes/node-section-nav";

/**
 * The section nav's one load-bearing behavior since it joined the `Segmented`
 * vocabulary (2026-10-09): EXACT-suffix pathname reading, hand-rolled where
 * TanStack's Link matching used to do it. On each section URL exactly one
 * pill is pressed — Overview never lights beside a section pill (the trap the
 * retired `activeOptions.exact` comment pinned), and the routes a press
 * navigates to are the section routes, so the pill row and the address agree
 * in both directions.
 */
function navNode(overrides: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "node1",
    name: "box",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "box",
    status: "online",
    lastSeenAt: null,
    agentVersion: "1.5.0",
    protocolVersion: 15,
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
    ...overrides,
  } as NodeDetail;
}

function renderAt(node: NodeDetail, url: string) {
  const root = createRootRoute();
  const base = createRoute({
    getParentRoute: () => root,
    path: "/nodes/$id",
    component: () => <NodeSectionNav node={node} />,
  });
  const service = createRoute({
    getParentRoute: () => base,
    path: "/service",
    component: () => <NodeSectionNav node={node} />,
  });
  const logs = createRoute({
    getParentRoute: () => base,
    path: "/logs",
    component: () => <NodeSectionNav node={node} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([base.addChildren([service, logs])]),
    history: createMemoryHistory({ initialEntries: [url] }),
    defaultPreload: false,
  });
  return render(<RouterProvider router={router} />);
}

const pressed = () =>
  ["Overview", "Service", "Logs"].filter(
    (name) => screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true",
  );

/** The router settles its first match on a microtask; wait for the group. */
async function renderReady(node: NodeDetail, url: string) {
  renderAt(node, url);
  if (node.kind === "agent" && (node.access === "owner" || node.access === "edit")) {
    await screen.findByRole("button", { name: "Overview" });
  }
}

afterEach(cleanup);

describe("NodeSectionNav pill activation", () => {
  it("lights exactly the pill the URL names, on all three section routes", async () => {
    await renderReady(navNode(), "/nodes/node1");
    expect(pressed()).toEqual(["Overview"]);
    cleanup();

    await renderReady(navNode(), "/nodes/node1/service");
    expect(pressed()).toEqual(["Service"]);
    cleanup();

    await renderReady(navNode(), "/nodes/node1/logs");
    expect(pressed()).toEqual(["Logs"]);
  });

  it("a press navigates, and the newly lit pill follows the new URL", async () => {
    await renderReady(navNode(), "/nodes/node1");
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    // The route change re-renders the same component at the new address; the
    // pressed pill moves with it (the control and the address never disagree).
    await waitFor(() => expect(pressed()).toEqual(["Logs"]));
  });

  it("renders no pills for a `view` grantee or the control-plane host", async () => {
    renderAt(navNode({ access: "view" }), "/nodes/node1");
    // No group appears at any point: query after the router would have
    // settled its (nav-less) match.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "Service" })).toBeNull();
    cleanup();

    renderAt(navNode({ kind: "local", access: "owner" }), "/nodes/node1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
