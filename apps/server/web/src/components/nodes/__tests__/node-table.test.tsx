import { describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NodeTable } from "@/components/nodes/node-table";

/** Node state stays accessible without a separate status column. */
function node(overrides: Partial<Node> = {}): Node {
  return {
    id: "a1",
    name: "mac mini",
    kind: "agent",
    os: "darwin",
    arch: "arm64",
    hostname: "mac-mini.local",
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
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
    held: null,
    ...overrides,
  };
}

async function renderTable(nodes: Node[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => {};
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <NodeTable nodes={nodes} onOpenConfig={noop} onShare={noop} onDelete={noop} onError={noop} />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return render(<RouterProvider router={router} />);
}

describe("NodeTable", () => {
  it("renders one aligned row per node: name, host, platform, owner, version, seen", async () => {
    await renderTable([
      node({
        id: "a1",
        name: "AI PC",
        hostname: "ai-pc",
        ownerLabel: "Ada",
        agentVersion: "0.15.0",
        lastSeenAt: new Date().toISOString(),
      }),
      node({ id: "b2", name: "mac mini", os: "linux", arch: "x64", status: "offline" }),
    ]);
    // Headers in the operator's order.
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Host",
      "Platform",
      "Owner",
      "Version",
      "Seen",
      "",
    ]);
    expect(screen.getByRole("link", { name: "AI PC" }).getAttribute("href")).toBe("/nodes/a1");
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
    const onlineCell = screen.getByText("AI PC").closest("td");
    const offlineCell = screen.getByText("mac mini").closest("td");
    expect(onlineCell && within(onlineCell).getByRole("img", { name: "Online" })).toBeTruthy();
    expect(offlineCell && within(offlineCell).getByRole("img", { name: "Offline" })).toBeTruthy();
    expect(screen.getByText("ai-pc")).toBeTruthy();
    expect(screen.getByText("Apple · arm64")).toBeTruthy();
    expect(screen.getByText("v0.15.0")).toBeTruthy();
    expect(screen.getByText("Linux · x64")).toBeTruthy();
    // No version yet is a dash, never a blank cell that reads as a layout bug.
    expect(screen.getAllByText("—").length).toBe(1);
    // Never seen reads as never, not as a stale age.
    expect(screen.getByText("never")).toBeTruthy();
    cleanup();
  });

  it("shows no heartbeat age for the built-in server, even after it is renamed", async () => {
    await renderTable([node({ id: "local", kind: "local", name: "Build host" })]);
    expect(screen.getAllByRole("cell")[5]?.textContent).toBe("—");
    expect(screen.queryByText("never")).toBeNull();
    expect(screen.getByRole("img", { name: "Online" })).toBeTruthy();
    cleanup();
  });

  it("leaves the owner unknown when the server doesn't disclose it", async () => {
    await renderTable([node({ access: "view", agentVersion: "1.0.0" })]);
    const cells = screen.getAllByRole("cell");
    expect(cells[3]?.textContent).toBe("—");
    expect(screen.queryByText("You")).toBeNull();
    cleanup();
  });

  it("keeps maintenance visible in the name cell alongside connection status", async () => {
    await renderTable([node({ maintenance: true })]);
    expect(screen.getByRole("img", { name: "Online" })).toBeTruthy();
    expect(screen.getByText("maintenance").closest("td")).toBe(screen.getByText("mac mini").closest("td"));
    cleanup();
  });
});
