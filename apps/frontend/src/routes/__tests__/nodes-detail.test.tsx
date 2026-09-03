import { afterEach, describe, expect, it } from "bun:test";
import { NODE_PROTOCOL_MIN_VERSION, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setConfirmHandler } from "@/lib/confirm";
import { Route } from "@/routes/nodes_.$id";
import type { NodeDetail } from "@/types/node";

/**
 * The node detail page's manager affordances (spec 2026-08-31 §9/§10):
 * Re-check gating (`nodeCanConfigure` = owner | edit — a `view` grantee gets
 * a disabled button, matching the read-only harness toggles), the owner-only
 * inline rename, the manager-only rotate-key flow with its plaintext-once
 * reveal, and the `agent too old` chip. The page component is rendered
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
    protocolVersion: 1,
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
  body?: string;
}

function mockFetch(node: NodeDetail) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (url.pathname === `/api/nodes/${node.id}` && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(node)));
    }
    if (url.pathname === `/api/nodes/${node.id}/rotate-key` && method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ nodeKey: "subshell_new_secret", message: "re-config by hand" })),
      );
    }
    if (url.pathname === `/api/nodes/${node.id}` && method === "PATCH") {
      return Promise.resolve(new Response(JSON.stringify({ ...node, name: "renamed" })));
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

describe("NodeDetailPage rename (owner-only PATCH)", () => {
  it("offers the inline editor to an owner-agent and PATCHes the name on Enter", async () => {
    const { calls, restore } = mockFetch(agentNode());
    try {
      renderDetail("agent1");
      const btn = await screen.findByRole("button", { name: "Rename node" });
      fireEvent.click(btn);
      const input = screen.getByRole("textbox", { name: "Rename node" }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/nodes/agent1");
        expect(JSON.parse(patch?.body ?? "{}")).toEqual({ name: "renamed" });
      });
    } finally {
      restore();
    }
  });

  it("never renders the editor for `local` (its name is fixed for everyone)", async () => {
    const { restore } = mockFetch(agentNode({ id: "local", kind: "local" }));
    try {
      renderDetail("local");
      await screen.findByText("Your access");
      expect(screen.queryByRole("button", { name: "Rename node" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("never renders the editor for a non-manager (the route 403s them too)", async () => {
    const { restore } = mockFetch(agentNode({ access: "edit", canManage: false }));
    try {
      renderDetail("agent1");
      await screen.findByText("Your access");
      expect(screen.queryByRole("button", { name: "Rename node" })).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("NodeDetailPage rotate-key", () => {
  afterEach(() => setConfirmHandler(null));

  it("confirms, POSTs once, and reveals the plaintext key (shown-once card)", async () => {
    setConfirmHandler(() => Promise.resolve(true));
    const { calls, restore } = mockFetch(agentNode());
    try {
      renderDetail("agent1");
      fireEvent.click(await screen.findByRole("button", { name: /Rotate key/ }));
      await waitFor(() => {
        expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/agent1/rotate-key")).toBe(true);
      });
      // POST exactly once — the reveal must not re-fire the rotation.
      expect(calls.filter((c) => c.method === "POST" && c.url === "/api/nodes/agent1/rotate-key").length).toBe(1);
      const revealed = await screen.findByText("subshell_new_secret");
      expect(revealed.textContent).toBe("subshell_new_secret");
      expect(screen.getByText(/shown once/i)).toBeDefined();
      // Done retires the plaintext from the DOM.
      fireEvent.click(screen.getByRole("button", { name: /Done — hide the key/ }));
      await waitFor(() => expect(screen.queryByText("subshell_new_secret")).toBeNull());
    } finally {
      restore();
    }
  });

  it("does not POST when the confirm is declined", async () => {
    let confirmAnswered = false;
    setConfirmHandler(() =>
      Promise.resolve(false).then((ok) => {
        confirmAnswered = true;
        return ok;
      }),
    );
    const { calls, restore } = mockFetch(agentNode());
    try {
      renderDetail("agent1");
      fireEvent.click(await screen.findByRole("button", { name: /Rotate key/ }));
      // Gate on the decline having actually been processed instead of a fixed
      // sleep: `rotateKey` continues in the microtask right after this promise
      // settles, so if a rogue POST were fired it would be recorded before
      // waitFor's next poll (a macrotask) can observe `confirmAnswered`.
      await waitFor(() => expect(confirmAnswered).toBe(true));
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/agent1/rotate-key")).toBe(false);
    } finally {
      restore();
    }
  });

  it("disables Rotate key for a non-manager", async () => {
    const { restore } = mockFetch(agentNode({ access: "edit", canManage: false }));
    try {
      renderDetail("agent1");
      const btn = await screen.findByRole("button", { name: /Rotate key/ });
      expect(btn.hasAttribute("disabled")).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("NodeDetailPage agent-too-old chip", () => {
  it("chips an offline agent whose reported protocol predates the control plane's", async () => {
    const { restore } = mockFetch(agentNode({ status: "offline", protocolVersion: 0 }));
    try {
      renderDetail("agent1");
      await screen.findByText("Your access");
      expect(screen.getByText("agent too old")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("stays silent for a current protocol", async () => {
    // Rides the constant: v1 became stale with the 2026-09-02 frame rename.
    const { restore } = mockFetch(agentNode({ status: "offline", protocolVersion: NODE_PROTOCOL_VERSION }));
    try {
      renderDetail("agent1");
      await screen.findByText("Your access");
      expect(screen.queryByText("agent too old")).toBeNull();
    } finally {
      restore();
    }
  });

  it("stays silent for an in-window older agent (v2 while the plane speaks v3)", async () => {
    // v3 (fs_ls) is additive — a v2 agent still connects and serves every
    // frame but folder browsing, so it is NOT the "too old to speak" chip.
    const { restore } = mockFetch(agentNode({ status: "offline", protocolVersion: NODE_PROTOCOL_MIN_VERSION }));
    try {
      renderDetail("agent1");
      await screen.findByText("Your access");
      expect(screen.queryByText("agent too old")).toBeNull();
    } finally {
      restore();
    }
  });

  it("stays silent for a never-seen agent (protocolVersion null)", async () => {
    const { restore } = mockFetch(agentNode({ status: "offline", protocolVersion: null }));
    try {
      renderDetail("agent1");
      await screen.findByText("Your access");
      expect(screen.queryByText("agent too old")).toBeNull();
    } finally {
      restore();
    }
  });

  it("stays silent while the agent is still online", async () => {
    const { restore } = mockFetch(agentNode({ status: "online", protocolVersion: 0 }));
    try {
      renderDetail("agent1");
      await screen.findByText("Your access");
      expect(screen.queryByText("agent too old")).toBeNull();
    } finally {
      restore();
    }
  });
});
