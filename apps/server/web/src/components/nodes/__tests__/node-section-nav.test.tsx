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
    held: null,
    ...overrides,
  };
}

/**
 * Mount the nav under the three section routes. Production wires them as FLAT
 * siblings (node-sections-flat.test.ts keeps it that way); nested here on
 * purpose: one nav instance survives the navigation the click test performs,
 * which is exactly what the test is about. Do not "fix" the shape.
 */
async function renderAt(node: NodeDetail, url: string) {
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
  // Resolve the initial match BEFORE render (the recipe the other component
  // tests use, e.g. detail-back-header.test.tsx): the first paint then carries
  // the match, and nothing commits outside act()'s scope afterwards.
  await router.load();
  return render(<RouterProvider router={router} />);
}

const pressed = () =>
  ["Overview", "Service", "Logs"].filter(
    (name) => screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true",
  );

/** Mount, and wait for the pill row when the fixture is supposed to get one. */
async function renderReady(node: NodeDetail, url: string) {
  await renderAt(node, url);
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
    await renderAt(navNode({ access: "view" }), "/nodes/node1");
    expect(screen.queryByRole("button", { name: "Service" })).toBeNull();
    cleanup();

    await renderAt(navNode({ kind: "local", access: "owner" }), "/nodes/node1");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
