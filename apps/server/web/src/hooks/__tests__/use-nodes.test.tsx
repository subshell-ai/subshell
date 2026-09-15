import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  useCreateSetupKey,
  useDeleteNode,
  useDeleteSetupKey,
  useNode,
  useNodes,
  useRecheckNode,
  useRenameNode,
  useRotateNodeKey,
  useSetupKeys,
} from "@/hooks/use-nodes";
import { ApiError } from "@/lib/api";
import type { Node } from "@/types/node";

/** One NodeView fixture — field names exactly as `node-view.ts` renders them. */
const NODE: Node = {
  id: "n1",
  name: "mac mini",
  kind: "agent",
  os: "darwin",
  arch: "arm64",
  hostname: "mac-mini",
  status: "online",
  lastSeenAt: new Date().toISOString(),
  agentVersion: "0.1.0",
  protocolVersion: 1,
  access: "owner",
  canManage: true,
  capabilities: ["launch"],
  harnesses: [{ harnessId: "claude", name: "Claude", installed: true, version: "1.2.3" }],
  inventoryStale: false,
  maintenance: false,
  maintenanceAt: null,
  maintenanceSource: null,
};

interface Call {
  method: string;
  url: string;
  body?: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Stubs `fetch` like the component tests do; the hook layer runs for real. */
function mockFetch(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    const custom = overrides[`${method} ${url.pathname}`];
    return Promise.resolve(custom ? custom() : json({}));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(cleanup);

describe("node reads", () => {
  it("useNodes reads the list from GET /api/nodes", async () => {
    const { restore } = mockFetch({ "GET /api/nodes": () => json({ nodes: [NODE] }) });
    try {
      const { result } = renderHook(() => useNodes(), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.nodes[0]?.name).toBe("mac mini");
      expect(result.current.data?.nodes[0]?.harnesses[0]?.installed).toBe(true);
    } finally {
      restore();
    }
  });

  it("useNode reads one node, shares included for config-capable viewers", async () => {
    const { restore } = mockFetch({
      "GET /api/nodes/n1": () =>
        json({
          ...NODE,
          shares: [{ id: "s1", granteeUserId: null, granteeName: "Everyone", permission: "view" }],
        }),
    });
    try {
      const { result } = renderHook(() => useNode("n1"), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.shares?.[0]?.granteeName).toBe("Everyone");
    } finally {
      restore();
    }
  });

  it("useSetupKeys lists the caller's keys (never a secret)", async () => {
    const { restore } = mockFetch({
      "GET /api/nodes/setup-keys": () =>
        json({
          keys: [{ id: "k1", label: "mac mini", createdAt: "x", expiresAt: "y", usedAt: null, consumedNodeId: null }],
        }),
    });
    try {
      const { result } = renderHook(() => useSetupKeys(), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.keys[0]?.label).toBe("mac mini");
    } finally {
      restore();
    }
  });
});

describe("node mutations", () => {
  it("useDeleteNode sends DELETE /api/nodes/:id", async () => {
    const { calls, restore } = mockFetch({ "DELETE /api/nodes/n1": () => json({ ok: true }) });
    try {
      const { result } = renderHook(() => useDeleteNode(), { wrapper });
      await result.current.mutateAsync("n1");
      expect(calls.find((c) => c.method === "DELETE" && c.url === "/api/nodes/n1")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("useDeleteNode surfaces the 409 NODE_RUNNING_SUBSHELLS code and message", async () => {
    const { restore } = mockFetch({
      "DELETE /api/nodes/n1": () =>
        json(
          {
            errId: "e1",
            code: "NODE_RUNNING_SUBSHELLS",
            message: "Node has 2 running subshells — delete again with ?force=true",
            statusCode: 409,
          },
          409,
        ),
    });
    try {
      const { result } = renderHook(() => useDeleteNode(), { wrapper });
      const err = await result.current.mutateAsync("n1").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).code).toBe("NODE_RUNNING_SUBSHELLS");
      expect((err as ApiError).message).toContain("running subshells");
    } finally {
      restore();
    }
  });

  it("useCreateSetupKey POSTs the label and returns the plaintext once", async () => {
    const { calls, restore } = mockFetch({
      "POST /api/nodes/setup-keys": () => json({ id: "k1", key: "nsk_abc", expiresAt: "y" }, 201),
    });
    try {
      const { result } = renderHook(() => useCreateSetupKey(), { wrapper });
      const created = await result.current.mutateAsync("mac mini");
      expect(created.key).toBe("nsk_abc");
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/nodes/setup-keys");
      expect(JSON.parse(post?.body ?? "{}")).toEqual({ label: "mac mini" });
    } finally {
      restore();
    }
  });

  it("useDeleteSetupKey DELETEs by id", async () => {
    const { calls, restore } = mockFetch({ "DELETE /api/nodes/setup-keys/k1": () => json({ ok: true }) });
    try {
      const { result } = renderHook(() => useDeleteSetupKey(), { wrapper });
      await result.current.mutateAsync("k1");
      expect(calls.find((c) => c.method === "DELETE" && c.url === "/api/nodes/setup-keys/k1")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("useRenameNode PATCHes {name} and invalidates list + detail (never writes the view through)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const written: unknown[] = [];
    const invalidated: unknown[] = [];
    const originalSet = client.setQueryData.bind(client);
    const originalInvalidate = client.invalidateQueries.bind(client);
    client.setQueryData = ((key: unknown, data: unknown) => {
      written.push([key, data]);
      return originalSet(key as never, data as never);
    }) as typeof client.setQueryData;
    client.invalidateQueries = ((opts: unknown) => {
      invalidated.push(opts);
      return originalInvalidate(opts as Parameters<typeof originalInvalidate>[0]);
    }) as typeof client.invalidateQueries;
    const spyWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { calls, restore } = mockFetch({ "PATCH /api/nodes/n1": () => json(NODE) });
    try {
      const { result } = renderHook(() => useRenameNode("n1"), { wrapper: spyWrapper });
      await result.current.mutateAsync("studio");
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/nodes/n1");
      expect(JSON.parse(patch?.body ?? "{}")).toEqual({ name: "studio" });
      // The PATCH response carries no `shares`; writing it into the detail
      // cache would silently erase them, so the contract is invalidate-only.
      expect(written.length).toBe(0);
      const keys = invalidated.map((o) => (o as { queryKey?: readonly unknown[] }).queryKey);
      expect(keys).toContainEqual(["nodes"]);
      expect(keys).toContainEqual(["node", "n1"]);
    } finally {
      restore();
    }
  });

  it("useRenameNode surfaces the 409 NODE_NAME_TAKEN message for the inline field error", async () => {
    const { restore } = mockFetch({
      "PATCH /api/nodes/n1": () =>
        json(
          { errId: "e1", code: "NODE_NAME_TAKEN", message: 'You already have a node named "studio"', statusCode: 409 },
          409,
        ),
    });
    try {
      const { result } = renderHook(() => useRenameNode("n1"), { wrapper });
      const err = await result.current.mutateAsync("studio").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("NODE_NAME_TAKEN");
      expect((err as ApiError).message).toContain("already have a node");
    } finally {
      restore();
    }
  });

  it("useRotateNodeKey POSTs rotate-key and hands back the plaintext once", async () => {
    const { calls, restore } = mockFetch({
      "POST /api/nodes/n1/rotate-key": () =>
        json({ nodeKey: "subshell_rotated_secret", message: "Re-configure the agent by hand." }),
    });
    try {
      const { result } = renderHook(() => useRotateNodeKey("n1"), { wrapper });
      const rotated = await result.current.mutateAsync();
      expect(rotated.nodeKey).toBe("subshell_rotated_secret");
      expect(rotated.message).toContain("Re-configure");
      expect(calls.find((c) => c.method === "POST" && c.url === "/api/nodes/n1/rotate-key")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("useRecheckNode POSTs the RPC trigger and invalidates the node view", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidated: unknown[] = [];
    const originalInvalidate = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((opts: unknown) => {
      invalidated.push(opts);
      return originalInvalidate(opts as Parameters<typeof originalInvalidate>[0]);
    }) as typeof client.invalidateQueries;
    const spyWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { calls, restore } = mockFetch({ "POST /api/nodes/n1/recheck": () => json({ ok: true }) });
    try {
      const { result } = renderHook(() => useRecheckNode("n1"), { wrapper: spyWrapper });
      await result.current.mutateAsync();
      expect(calls.find((c) => c.method === "POST" && c.url === "/api/nodes/n1/recheck")).toBeDefined();
      // The fresh snapshot rode the WS event path into the DB — the view is
      // re-read, not patched, so invalidation is the whole contract.
      const keys = invalidated.map((o) => (o as { queryKey?: readonly unknown[] }).queryKey);
      expect(keys).toContainEqual(["node", "n1"]);
      expect(keys).toContainEqual(["nodes"]);
    } finally {
      restore();
    }
  });
});
