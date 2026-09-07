import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useNodeShares, useSetNodeShares } from "@/hooks/use-node-shares";

/**
 * Node sharing hooks (spec 2026-08-31 §9/§10) — mirror of the subshell-shares
 * contract: GET returns the grant set, PUT replaces it whole. Same fetch-stub
 * style as `use-nodes.test.tsx`.
 */
interface Call {
  method: string;
  url: string;
  body?: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

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

/** A test-owned QueryClient so invalidation can be observed directly. */
function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated: unknown[] = [];
  const originalInvalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((opts: unknown) => {
    invalidated.push(opts);
    return originalInvalidate(opts as Parameters<typeof originalInvalidate>[0]);
  }) as typeof client.invalidateQueries;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper, invalidated };
}

afterEach(cleanup);

describe("useNodeShares", () => {
  it("GETs the grant set from /api/nodes/:id/shares", async () => {
    const { wrapper } = makeWrapper();
    const { restore } = mockFetch({
      "GET /api/nodes/n1/shares": () =>
        json({ shares: [{ id: "s1", granteeUserId: null, granteeName: "Everyone", permission: "edit" }] }),
    });
    try {
      const { result } = renderHook(() => useNodeShares("n1"), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.shares[0]?.granteeName).toBe("Everyone");
      expect(result.current.data?.shares[0]?.permission).toBe("edit");
    } finally {
      restore();
    }
  });
});

describe("useSetNodeShares", () => {
  it("PUTs the complete replacement set", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({
      "PUT /api/nodes/n1/shares": () =>
        json({ shares: [{ id: "s1", granteeUserId: null, granteeName: "Everyone", permission: "view" }] }),
    });
    try {
      const { result } = renderHook(() => useSetNodeShares("n1"), { wrapper });
      await result.current.mutateAsync([{ granteeUserId: null, permission: "view" }]);
      const put = calls.find((c) => c.method === "PUT" && c.url === "/api/nodes/n1/shares");
      expect(put).toBeDefined();
      expect(JSON.parse(put?.body ?? "{}")).toEqual({ shares: [{ granteeUserId: null, permission: "view" }] });
    } finally {
      restore();
    }
  });

  it("invalidates the node's shares, detail and list on success", async () => {
    const { wrapper, invalidated } = makeWrapper();
    const { restore } = mockFetch();
    try {
      const { result } = renderHook(() => useSetNodeShares("n1"), { wrapper });
      await result.current.mutateAsync([]);
      const keys = invalidated.map((o) => (o as { queryKey?: readonly unknown[] }).queryKey);
      expect(keys).toContainEqual(["node-shares", "n1"]);
      expect(keys).toContainEqual(["node", "n1"]);
      expect(keys).toContainEqual(["nodes"]);
    } finally {
      restore();
    }
  });
});
