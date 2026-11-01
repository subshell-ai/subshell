import { afterEach, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeMcpCard } from "@/components/nodes/node-mcp-card";

/**
 * The node's MCP-use card. The SSH card beside it is opt-in, so an absent
 * flag reads OFF there; THIS one reads ALLOWED, because MCP wiring predates
 * the switch and a payload cached before the field existed must not strip
 * comms. The first cells below pin both halves of that polarity, and a future
 * `node.mcpEnabled === true` edit fails them.
 */

function node(over: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "node1",
    name: "box",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "box",
    status: "online",
    lastSeenAt: null,
    agentVersion: "3.2.0",
    protocolVersion: 27,
    access: "owner",
    canManage: true,
    canRetire: true,
    canLaunch: true,
    capabilities: [],
    allowedDirs: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    sshEnabled: false,
    sshWideForwards: false,
    held: null,
    ...over,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mount(n: NodeDetail) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeMcpCard node={n} />
    </QueryClientProvider>,
  );
}

it("reads an ABSENT mcpEnabled as allowed: a pre-switch payload is not a refusal", () => {
  // The whole inversion in one assertion. The ssh field's cache-tolerance
  // reads the opposite way; flip this card to `=== true` and every node
  // cached before protocol 27 starts rendering a false refusal.
  mount(node({ mcpEnabled: undefined }));
  expect(screen.getByRole("switch", { name: "Allow the subshell MCP" }).getAttribute("aria-checked")).toBe("true");
});

for (const enabled of [false, true]) {
  it(`writes the opposite MCP setting when currently ${enabled}`, async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("{}");
    }) as unknown as typeof fetch;
    mount(node({ mcpEnabled: enabled }));
    const sw = screen.getByRole("switch", { name: "Allow the subshell MCP" });
    expect(sw.getAttribute("aria-checked")).toBe(String(enabled));
    fireEvent.click(sw);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toContain("/api/nodes/node1/mcp-enabled");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ on: !enabled });
  });
}

it("shows the refusal state to a viewer who cannot manage it, with the owner as the reason", () => {
  mount(node({ mcpEnabled: false, access: "edit", canManage: false }));
  expect(screen.getByRole("switch", { name: "Allow the subshell MCP" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("switch").hasAttribute("data-disabled")).toBe(true);
  expect(screen.getByText("Only this node’s owner can change this setting.")).toBeTruthy();
});

it("names the admin as the changer for the built-in node", () => {
  mount(node({ kind: "local", id: "local", canManage: false }));
  expect(screen.getByText("An admin can change this setting.")).toBeTruthy();
});

it("shows failed writes without changing the reported state", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Permission changed." }), { status: 403 })) as unknown as typeof fetch;
  mount(node({ mcpEnabled: true }));
  fireEvent.click(screen.getByRole("switch", { name: "Allow the subshell MCP" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
});
