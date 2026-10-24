import { afterEach, describe, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodePreviewCard } from "@/components/nodes/node-preview-card";

/**
 * The Preview card on the node page (task-12 Step 4, pinned by Step 1): the
 * same gate and tooltip posture as the SSH card beside it - owner-only flip,
 * honest remedy line for a non-owner, and a single PUT of `{on}` at the Task
 * 3 route. The fetch mock is the route, and the node arrives as a prop.
 */

type Call = { method: string; url: string; body?: Record<string, unknown> };

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
    previewEnabled: false,
    held: null,
    ...over,
  } as NodeDetail;
}

function mount(n: NodeDetail) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      body: init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify({ ...n, previewEnabled: true })));
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <NodePreviewCard node={n} />
    </QueryClientProvider>,
  );
  return {
    view,
    calls,
    restore: () => (globalThis.fetch = original),
  };
}

afterEach(() => cleanup());

describe("the Preview switch", () => {
  it("reflects the stored flag and asks the route when flipped", async () => {
    const h = mount(node({ previewEnabled: false }));
    try {
      const toggle = screen.getByRole("switch", { name: /allow apps and screens/i });
      // Cast-and-read, this repo's convention (Base UI wears aria-checked and
      // aria-disabled; there is no jest-dom dependency here).
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(toggle.matches(":disabled, [aria-disabled=true]")).toBe(false);
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(h.calls.find((c) => c.method === "PUT" && c.url === "/api/nodes/node1/preview-enabled")).toBeTruthy(),
      );
      expect(h.calls.find((c) => c.method === "PUT" && c.url === "/api/nodes/node1/preview-enabled")?.body).toEqual({
        on: true,
      });
    } finally {
      h.restore();
    }
  });

  it("a checked switch mirrors the stored on-state", () => {
    const h = mount(node({ previewEnabled: true }));
    try {
      expect(screen.getByRole("switch", { name: /allow apps and screens/i }).getAttribute("aria-checked")).toBe("true");
    } finally {
      h.restore();
    }
  });

  it("a non-owner sees it disabled with the owner remedy", () => {
    const h = mount(node({ canManage: false, access: "edit" }));
    try {
      expect(
        screen.getByRole("switch", { name: /allow apps and screens/i }).matches(":disabled, [aria-disabled=true]"),
      ).toBe(true);
      expect(screen.getByText(/only this node/i)).toBeTruthy();
    } finally {
      h.restore();
    }
  });

  it("the local host answers with the admin remedy line", () => {
    const h = mount(node({ kind: "local", canManage: false }));
    try {
      expect(screen.getByText(/an admin can change this setting/i)).toBeTruthy();
    } finally {
      h.restore();
    }
  });
});
