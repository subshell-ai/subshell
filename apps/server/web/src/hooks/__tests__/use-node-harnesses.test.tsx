import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HARNESS_QUERY_KEY, useNodeHarnesses } from "@/hooks/use-harnesses";
import type { NodeDetail } from "@/types/node";

/**
 * Per-node harness READS: the harness rows ride the node detail query, with no
 * second endpoint of their own.
 *
 * Changing them is a different thing entirely and lives with the plugin
 * mutation — a node's set is what it has INSTALLED, so there is no enable flag
 * to toggle here (spec 2026-09-09 §6).
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
  protocolVersion: null,
  access: "owner",
  canManage: true,
  capabilities: [],
  harnesses: [
    { harnessId: "claude", name: "Claude", installed: true, version: "1.2.3" },
    { harnessId: "hermes", name: "Hermes", installed: false },
  ],
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
