import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  HARNESS_QUERY_KEY,
  nodeHarnessErrorMessage,
  useNodeHarnesses,
  useSetNodeHarnessEnabled,
} from "@/hooks/use-harnesses";
import { ApiError } from "@/lib/api";
import { NODE_QUERY_KEY } from "@/lib/query-keys";
import type { NodeDetail } from "@/types/node";

/**
 * Per-node harness reads/toggles (spec 2026-08-31 §6.2/§9): the harness rows
 * ride the node detail query (no second endpoint), and the PATCH answers with
 * a full NodeView the cache adopts directly.
 */
const NODE: NodeDetail = {
  id: "n1",
  name: "mac mini",
  kind: "agent",
  os: "darwin",
  arch: "arm64",
  hostname: "mac-mini",
  status: "online",
  lastSeenAt: null,
  agentVersion: null,
  access: "owner",
  canManage: true,
  capabilities: [],
  harnesses: [
    { harnessId: "claude", enabled: true, installed: true, version: "1.2.3" },
    { harnessId: "hermes", enabled: false, installed: false },
  ],
  inventoryStale: false,
};

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

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(cleanup);

describe("useNodeHarnesses", () => {
  it("derives harness rows from the node query — one fetch, no second endpoint", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({ "GET /api/nodes/n1": () => json(NODE) });
    try {
      const { result } = renderHook(() => useNodeHarnesses("n1"), { wrapper });
      await waitFor(() => expect(result.current.harnesses.length).toBe(2));
      expect(result.current.harnesses[0]?.version).toBe("1.2.3");
      expect(calls.filter((c) => c.method === "GET").length).toBe(1);
      expect(HARNESS_QUERY_KEY[0]).toBe("harnesses");
    } finally {
      restore();
    }
  });
});

describe("useSetNodeHarnessEnabled", () => {
  it("PATCHes /api/nodes/:id/harnesses/:harnessId with {enabled}", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({
      "PATCH /api/nodes/n1/harnesses/hermes": () => json({ ...NODE, harnesses: [] }),
    });
    try {
      const { result } = renderHook(() => useSetNodeHarnessEnabled("n1"), { wrapper });
      await result.current.mutateAsync({ harnessId: "hermes", enabled: true });
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/nodes/n1/harnesses/hermes");
      expect(patch).toBeDefined();
      expect(JSON.parse(patch?.body ?? "{}")).toEqual({ enabled: true });
    } finally {
      restore();
    }
  });

  it("adopts the returned NodeView into the node cache (chips refresh without a refetch)", async () => {
    const { client, wrapper } = makeWrapper();
    const updated = { ...NODE, inventoryStale: true };
    const { restore } = mockFetch({ "PATCH /api/nodes/n1/harnesses/hermes": () => json(updated) });
    try {
      client.setQueryData([...NODE_QUERY_KEY, "n1"], NODE);
      const { result } = renderHook(() => useSetNodeHarnessEnabled("n1"), { wrapper });
      await result.current.mutateAsync({ harnessId: "hermes", enabled: true });
      expect(client.getQueryData([...NODE_QUERY_KEY, "n1"])).toMatchObject({ inventoryStale: true });
    } finally {
      restore();
    }
  });

  it("surfaces the inventory-gated 409 with the server's own message", async () => {
    const { wrapper } = makeWrapper();
    const { restore } = mockFetch({
      "PATCH /api/nodes/n1/harnesses/hermes": () =>
        json(
          {
            errId: "e1",
            code: "INPUT_VALIDATION_ERROR",
            message: '"Hermes" is not installed on "mac mini"',
            statusCode: 409,
          },
          409,
        ),
    });
    try {
      const { result } = renderHook(() => useSetNodeHarnessEnabled("n1"), { wrapper });
      const err = await result.current.mutateAsync({ harnessId: "hermes", enabled: true }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect(nodeHarnessErrorMessage(err)).toContain("not installed");
    } finally {
      restore();
    }
  });

  it("maps non-409 failures to a generic message", () => {
    expect(nodeHarnessErrorMessage(new ApiError(500, "boom"))).toBe("Could not change the harness state.");
  });
});
