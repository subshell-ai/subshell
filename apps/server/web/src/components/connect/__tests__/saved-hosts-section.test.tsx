import { afterEach, describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SavedHostsSection } from "@/components/connect/saved-hosts-section";
import type { SshSavedHost } from "@/lib/ssh";

/**
 * The ledger under the panel (contract 7): label-over-detail rows, delete on
 * Remembered, remember on Recent, saved rows never shown twice, and the two
 * one-sentence empties. Wire-mocked the way the panel test mocks it.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const savedRow: SshSavedHost = {
  id: "s1",
  destination: "web01.example.com:22",
  alias: "web",
  nodeId: "a1",
  savedAt: "2026-10-01T00:00:00.000Z",
  lastConnectAt: "2026-10-05T00:00:00.000Z",
};
const recentRow: SshSavedHost = {
  id: "r1",
  destination: "db.example.com:22",
  alias: null,
  nodeId: "a1",
  savedAt: null,
  lastConnectAt: "2026-10-06T00:00:00.000Z",
};

function node(overrides: Partial<Node>): Node {
  return {
    id: "n",
    name: "node",
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
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
    sshEnabled: false,
    held: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

async function renderSection(ledger: unknown) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname + url.search,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    if (url.pathname === "/api/ssh/saved-hosts" && method === "GET") return Promise.resolve(json(ledger));
    if (url.pathname === "/api/nodes") {
      return Promise.resolve(json({ nodes: [node({ id: "a1", name: "mac mini", sshEnabled: true })] }));
    }
    return Promise.resolve(json({}));
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SavedHostsSection />
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return { calls, restore: () => (globalThis.fetch = original) };
}

afterEach(cleanup);

describe("SavedHostsSection", () => {
  it("renders remembered and recent rows label-over-detail, the machine named in the detail", async () => {
    const { restore } = await renderSection({ saved: [savedRow], recent: [savedRow, recentRow], defaultNodeId: null });
    try {
      expect(screen.getByText("web")).toBeDefined(); // the ALIAS is the display
      expect(screen.getByText("mac mini · 2026-10-01")).toBeDefined(); // saved date rides remembered rows
      expect(screen.getByText("db.example.com:22")).toBeDefined();
      expect(screen.getByText("mac mini · 2026-10-06")).toBeDefined(); // last connect rides recents
      // The row already Saved appears once, under Remembered (reads once).
      expect(screen.getAllByText("web")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a remembered row forgets by id; a recent row remembers on its own machine", async () => {
    const { calls, restore } = await renderSection({ saved: [savedRow], recent: [recentRow], defaultNodeId: null });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Forget web" }));
      await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
      expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/ssh/saved-hosts/s1");
      fireEvent.click(screen.getByRole("button", { name: "Remember db.example.com:22" }));
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.url).toBe("/api/ssh/saved-hosts");
      expect(put?.body).toEqual({ node: "a1", destination: "db.example.com:22" }); // the row's own machine, no alias
    } finally {
      restore();
    }
  });

  it("the two empty states are one short sentence each", async () => {
    const { restore } = await renderSection({ saved: [], recent: [], defaultNodeId: null });
    try {
      expect(screen.getByText("No remembered destinations yet.")).toBeDefined();
      expect(screen.getByText("No recent destinations yet.")).toBeDefined();
    } finally {
      restore();
    }
  });
});
