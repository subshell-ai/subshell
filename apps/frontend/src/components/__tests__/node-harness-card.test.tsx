import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NodeHarnessCard } from "@/components/nodes/node-harness-card";
import type { NodeDetail } from "@/types/node";

/**
 * The detail page's harness card (spec 2026-08-31 §9): one row per registered
 * harness with installed/enabled chips, a toggle that only config-capable
 * viewers can move, and the server's own 409 copy (fresh inventory says
 * "not installed") surfaced inline.
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
  inventoryStale: true,
};

function mockFetch(patch: () => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (method === "PATCH") return Promise.resolve(patch());
    if (url.pathname === "/api/nodes/n1") return Promise.resolve(new Response(JSON.stringify(NODE)));
    if (url.pathname === "/api/setup/harnesses")
      return Promise.resolve(
        new Response(JSON.stringify([{ id: "claude", name: "Claude Code", enabled: true, installed: true }])),
      );
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

function renderCard(canConfigure: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeHarnessCard nodeId="n1" canConfigure={canConfigure} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("NodeHarnessCard", () => {
  it("lists every harness with registry names and the stale hint", async () => {
    const restore = mockFetch(() => new Response(JSON.stringify(NODE)));
    try {
      renderCard(true);
      expect(await screen.findByText("Claude Code")).toBeDefined();
      // Not in the registry fixture — the raw plugin id stands in.
      expect(screen.getByText("hermes")).toBeDefined();
      expect(screen.getByText(/inventory may be outdated/i)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("disables every toggle for a viewer who cannot configure the node", async () => {
    const restore = mockFetch(() => new Response(JSON.stringify(NODE)));
    try {
      renderCard(false);
      await screen.findByText("Claude Code");
      for (const sw of screen.getAllByRole("switch")) {
        expect(sw.getAttribute("aria-disabled")).toBe("true");
      }
    } finally {
      restore();
    }
  });

  it("surfaces the 409 inventory gate inline", async () => {
    const restore = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            errId: "e1",
            code: "INPUT_VALIDATION_ERROR",
            message: '"Hermes" is not installed on "mac mini"',
            statusCode: 409,
          }),
          { status: 409 },
        ),
    );
    try {
      renderCard(true);
      await screen.findByText("Claude Code");
      const switches = screen.getAllByRole("switch");
      fireEvent.click(switches[1]);
      expect(await screen.findByText(/is not installed on/)).toBeDefined();
    } finally {
      restore();
    }
  });
});
