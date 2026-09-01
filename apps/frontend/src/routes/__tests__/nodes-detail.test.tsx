import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/nodes_.$id";
import type { NodeDetail } from "@/types/node";

/**
 * The node detail page's Re-check gating (spec 2026-08-31 §9): the recheck
 * route runs with `nodeCanConfigure` (owner | edit), so a `view` grantee must
 * NOT get an enabled button — the disabled+tooltip treatment matches the
 * read-only harness toggles on the same page. The page component is rendered
 * through the real route object (its `useParams` is strict), mounted under a
 * minimal memory router the way routeTree.gen wires it.
 */
function agentNode(overrides: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "agent1",
    name: "box",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "box",
    status: "online",
    lastSeenAt: null,
    agentVersion: "0.1.0",
    access: "owner",
    canManage: true,
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
}

function mockFetch(node: NodeDetail) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname });
    if (url.pathname === `/api/nodes/${node.id}` && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(node)));
    }
    if (url.pathname === "/api/setup/harnesses" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify([])));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDetail(id: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const nodeRoute = Route.update({
    id: "/nodes_/$id",
    path: "/nodes/$id",
    getParentRoute: () => rootRoute,
  } as any);
  const router = createRouter({
    routeTree: rootRoute.addChildren([nodeRoute]),
    history: createMemoryHistory({ initialEntries: [`/nodes/${id}`] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("NodeDetailPage re-check gating", () => {
  it("disables Re-check for a `view` grantee and POSTs nothing on click", async () => {
    const { calls, restore } = mockFetch(agentNode({ access: "view", canManage: false }));
    try {
      renderDetail("agent1");
      const btn = await screen.findByRole("button", { name: /Re-check/ });
      expect(btn.hasAttribute("disabled")).toBe(true);
      expect(btn.getAttribute("title")).toContain("edit grantee");
      fireEvent.click(btn);
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/agent1/recheck")).toBe(false);
    } finally {
      restore();
    }
  });

  it("enables Re-check for an `edit` grantee and POSTs on click", async () => {
    const { calls, restore } = mockFetch(agentNode({ access: "edit", canManage: false }));
    try {
      renderDetail("agent1");
      const btn = await screen.findByRole("button", { name: /Re-check/ });
      expect(btn.hasAttribute("disabled")).toBe(false);
      fireEvent.click(btn);
      await waitFor(() => {
        expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/agent1/recheck")).toBe(true);
      });
    } finally {
      restore();
    }
  });

  it("keeps the owner path enabled", async () => {
    const { restore } = mockFetch(agentNode());
    try {
      renderDetail("agent1");
      const btn = await screen.findByRole("button", { name: /Re-check/ });
      expect(btn.hasAttribute("disabled")).toBe(false);
    } finally {
      restore();
    }
  });

  it("never offers Re-check on the local node (its probe is live on every read)", async () => {
    const { restore } = mockFetch(agentNode({ id: "local", kind: "local", access: "owner" }));
    try {
      renderDetail("local");
      await screen.findByText("Your access");
      expect(screen.queryByRole("button", { name: /Re-check/ })).toBeNull();
    } finally {
      restore();
    }
  });
});
