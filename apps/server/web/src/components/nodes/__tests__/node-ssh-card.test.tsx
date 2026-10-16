import { afterEach, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeSshCard } from "@/components/nodes/node-ssh-card";

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
    agentVersion: "1.0.0",
    protocolVersion: 12,
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
      <NodeSshCard node={n} />
    </QueryClientProvider>,
  );
}
for (const enabled of [false, true]) {
  it(`writes the opposite SSH setting when currently ${enabled}`, async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("{}");
    }) as unknown as typeof fetch;
    mount(node({ sshEnabled: enabled }));
    expect(screen.getByRole("switch", { name: "Allow SSH" }).getAttribute("aria-checked")).toBe(String(enabled));
    fireEvent.click(screen.getByRole("switch", { name: "Allow SSH" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toContain("/api/nodes/node1/ssh-enabled");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ on: !enabled });
  });
}
it("offers the wide-forwards switch beside the SSH switch, and writes its own endpoint", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}");
  }) as unknown as typeof fetch;
  mount(node({ sshEnabled: true }));
  const wide = screen.getByRole("switch", { name: "Allow wide port forwards" });
  expect(wide.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(wide);
  await waitFor(() => expect(calls.some((c) => c.url.includes("/api/nodes/node1/ssh-wide-forwards"))).toBe(true));
  const call = calls.find((c) => c.url.includes("/ssh-wide-forwards"));
  expect(JSON.parse(String(call?.init?.body))).toEqual({ on: true });
});

it("hides the wide-forwards switch while SSH itself is off, and says who owns it to others", () => {
  mount(node({ sshEnabled: false }));
  expect(screen.queryByRole("switch", { name: "Allow wide port forwards" })).toBeNull();
  mount(node({ sshEnabled: true, access: "edit", canManage: false }));
  const wide = screen.getByRole("switch", { name: "Allow wide port forwards" });
  expect(wide.hasAttribute("data-disabled")).toBe(true);
});

it("shows configuration to edit viewers without offering changes", () => {
  mount(node({ access: "edit", canManage: false }));
  expect(screen.getByRole("switch").hasAttribute("data-disabled")).toBe(true);
  expect(screen.getByText("Only this node’s owner can change this setting.")).toBeTruthy();
});
it("shows failed writes without changing the reported state", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Permission changed." }), { status: 403 })) as unknown as typeof fetch;
  mount(node());
  fireEvent.click(screen.getByRole("switch", { name: "Allow SSH" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
});
