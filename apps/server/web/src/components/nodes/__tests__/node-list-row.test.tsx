import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeListRow } from "@/components/nodes/node-list-row";
import { type ConfirmOptions, setConfirmHandler } from "@/lib/confirm";
import type { Node } from "@/types/node";

/**
 * The Nodes-list row's maintenance action, which exists to answer one thing
 * the list payload cannot: HOW MANY subshells the flip would stop.
 * `runningSubshells` rides the detail view only, so the row reads it at the
 * moment it is asked for — and a detail read that fails must hedge the prompt
 * rather than refuse the act.
 */
function node(overrides: Partial<Node> = {}): Node {
  return {
    id: "a1",
    name: "mac mini",
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
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** Serves the node detail (or refuses it) and records every request. */
function mockFetch({ runningSubshells, detailStatus = 200 }: { runningSubshells?: number; detailStatus?: number }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (url.pathname === "/api/nodes/a1" && method === "GET") {
      if (detailStatus !== 200) {
        return Promise.resolve(new Response(JSON.stringify({ message: "nope" }), { status: detailStatus }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ...node(), runningSubshells })));
    }
    return Promise.resolve(new Response(JSON.stringify(node({ maintenance: true }))));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function mockConfirm(answer: boolean) {
  const seen: ConfirmOptions[] = [];
  const previous = setConfirmHandler((options) => {
    seen.push(options);
    return Promise.resolve(answer);
  });
  return { seen, restore: () => setConfirmHandler(previous) };
}

function renderRow(n: Node, onError: (m: string | null) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeListRow node={n} onOpenConfig={() => {}} onShare={() => {}} onDelete={() => {}} onError={onError} />
    </QueryClientProvider>,
  );
}

async function pickMaintenance(name: string, item: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

afterEach(cleanup);

describe("NodeListRow", () => {
  it("reads the count off the detail view before asking, then PUTs", async () => {
    const fetchMock = mockFetch({ runningSubshells: 4 });
    const confirm = mockConfirm(true);
    try {
      renderRow(node());
      await pickMaintenance("mac mini", "Start maintenance…");
      await waitFor(() => expect(confirm.seen[0]?.description).toContain("4 subshells running here"));
      await waitFor(() =>
        expect(fetchMock.calls.some((c) => c.method === "PUT" && c.url === "/api/nodes/a1/maintenance")).toBe(true),
      );
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("hedges the count when the detail read refuses, rather than refusing the act", async () => {
    const fetchMock = mockFetch({ detailStatus: 500 });
    const confirm = mockConfirm(true);
    try {
      renderRow(node());
      await pickMaintenance("mac mini", "Start maintenance…");
      await waitFor(() => expect(confirm.seen[0]?.description).toContain("Any subshells running here"));
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("ends maintenance with no detail read and no prompt", async () => {
    const fetchMock = mockFetch({ runningSubshells: 0 });
    const confirm = mockConfirm(true);
    try {
      renderRow(node({ maintenance: true }));
      await pickMaintenance("mac mini", "End maintenance");
      await waitFor(() =>
        expect(fetchMock.calls.filter((c) => c.method === "PUT")).toEqual([
          { method: "PUT", url: "/api/nodes/a1/maintenance", body: '{"on":false}' },
        ]),
      );
      expect(confirm.seen).toEqual([]);
      expect(fetchMock.calls.some((c) => c.method === "GET")).toBe(false);
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("hands the server's refusal to the page's error line", async () => {
    const calls: (string | null)[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Only the owner can do that" }), { status: 403 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ...node(), runningSubshells: 0 }), { status: 200 }));
    }) as typeof fetch;
    const confirm = mockConfirm(true);
    try {
      renderRow(node(), (m) => calls.push(m));
      await pickMaintenance("mac mini", "Start maintenance…");
      await waitFor(() => expect(calls.some((m) => m?.includes("Only the owner can do that"))).toBe(true));
    } finally {
      confirm.restore();
      globalThis.fetch = original;
    }
  });
});
