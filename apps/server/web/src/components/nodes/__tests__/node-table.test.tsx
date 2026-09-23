import { describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NodeTable } from "@/components/nodes/node-table";

/**
 * The table view of the Nodes list: the fleet-at-a-glance columns the card
 * row cannot offer (aligned across machines), and the two facts its fixed
 * grid must still never hide — the `maintenance` warning and the seen-age
 * word when nothing has ever been seen.
 */
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

function renderTable(nodes: Node[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => {};
  return render(
    <QueryClientProvider client={client}>
      <NodeTable nodes={nodes} onOpenConfig={noop} onShare={noop} onDelete={noop} onError={noop} />
    </QueryClientProvider>,
  );
}

describe("NodeTable", () => {
  it("renders one aligned row per node: name, host, platform, status, agent, seen", () => {
    renderTable([
      node({
        id: "a1",
        name: "AI PC",
        hostname: "ai-pc",
        agentVersion: "0.15.0",
        lastSeenAt: new Date().toISOString(),
      }),
      node({ id: "b2", name: "mac mini", os: "linux", arch: "x64", status: "offline" }),
    ]);
    // Headers in the operator's order.
    for (const h of ["Name", "Host", "Platform", "Status", "Agent", "Seen"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    }
    expect(screen.getByText("AI PC")).toBeTruthy();
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

  it("the maintenance warning rides the status cell — a machine in maintenance is otherwise all-green", () => {
    renderTable([node({ maintenance: true })]);
    expect(screen.getByText("online")).toBeTruthy();
    expect(screen.getByText("maintenance")).toBeTruthy();
    cleanup();
  });
});
