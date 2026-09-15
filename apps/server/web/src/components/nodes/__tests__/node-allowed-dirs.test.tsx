import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NodeAllowedDirs } from "@/components/nodes/node-allowed-dirs";
import type { Node } from "@/types/node";

/**
 * The card is read-visible to everyone who can see the node and editable only
 * by whoever manages it. Both halves matter: a grantee who cannot see the
 * rules cannot understand a refusal, and a grantee who CAN edit them makes the
 * boundary meaningless against exactly the people it constrains.
 */
function node(over: Partial<Node> = {}): Node {
  return {
    id: "n1",
    name: "buildbox",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "buildbox",
    status: "online",
    lastSeenAt: null,
    agentVersion: "0.4.0",
    protocolVersion: 1,
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
    ...over,
  };
}

function renderCard(over: Partial<Node> = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NodeAllowedDirs node={node(over)} />
    </QueryClientProvider>,
  );
}

describe("NodeAllowedDirs", () => {
  afterEach(cleanup);

  it("says an empty list means UNRESTRICTED, not locked down", () => {
    // The invariant most likely to be misread by a human. If the card implied
    // "nothing is permitted", an operator would think the node was broken.
    renderCard({ allowedDirs: [] });
    expect(document.body.textContent).toContain("Any directory");
  });

  it("lists the rules in force", () => {
    renderCard({ allowedDirs: ["/home/theo/projects", "/srv/work"] });
    expect(screen.getByText("/home/theo/projects")).toBeDefined();
    expect(screen.getByText("/srv/work")).toBeDefined();
  });

  it("states that running panes are unaffected", () => {
    // Otherwise an operator tightening the rules on a busy node cannot tell
    // whether they are about to kill live work.
    renderCard({ allowedDirs: ["/srv/work"] });
    expect(document.body.textContent).toContain("already running are unaffected");
  });

  it("says the node enforces the rules itself", () => {
    renderCard({ allowedDirs: ["/srv/work"] });
    expect(document.body.textContent).toContain("enforces this itself");
  });

  it("offers editing controls to a manager", () => {
    renderCard({ canManage: true, allowedDirs: ["/srv/work"] });
    expect(screen.getByRole("button", { name: /add directory/i })).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove /srv/work" })).toBeDefined();
  });

  it("shows a non-manager the rules but no way to change them", () => {
    renderCard({ canManage: false, access: "edit", allowedDirs: ["/srv/work"] });
    expect(screen.getByText("/srv/work")).toBeDefined();
    expect(screen.queryByRole("button", { name: /add directory/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });
});
