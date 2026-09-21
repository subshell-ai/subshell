import { afterEach, describe, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NodeUpdateCard } from "@/components/nodes/node-update-card";

/**
 * The node page's Update card: the same `POST /api/nodes/:id/update` the
 * Updates table rows drive, in card form. The fetch mock is the route, in the
 * style of `components/__tests__/updates-node-rows.test.tsx`; the node view
 * arrives as a prop (the caller fetched it), so the card itself asks for
 * nothing on mount.
 */

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
    canLaunch: true,
    capabilities: [],
    allowedDirs: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    held: null,
    ...over,
  };
}

function mount(n: NodeDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeUpdateCard node={n} />
    </QueryClientProvider>,
  );
}

describe("NodeUpdateCard", () => {
  afterEach(cleanup);

  it("shows the pressed button as Updating while its POST is in flight", async () => {
    // The POST blocks for the node's whole download-and-restart window (up to
    // five minutes), so the card has to say it is working. The button stays
    // live even for an OFFLINE node (a held machine is what this exists for),
    // which is why "offline" is not an option in this test's node either.
    const original = globalThis.fetch;
    let release: () => void = () => {};
    globalThis.fetch = ((_input: unknown, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response("{}", { status: 202 }));
      })) as typeof globalThis.fetch;
    try {
      mount(node({ agentVersion: null }));
      expect(screen.getByText("Running an unreported version")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Update to latest" }));
      const updating = (await screen.findByRole("button", { name: "Updating…" })) as HTMLButtonElement;
      expect(updating.disabled).toBe(true);
      expect(updating.querySelector("svg")).toBeTruthy();
      release();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("names the target version once the route answers 202", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          ok: true,
          from: "1.0.0",
          to: "9.9.9",
          url: "http://plane.test/api/downloads/node/linux-x64",
        }),
        { status: 202 },
      )) as typeof globalThis.fetch;
    try {
      mount(node());
      expect(screen.getByText("Running 1.0.0")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Update to latest" }));
      expect(
        await screen.findByText("Update accepted. box is installing 9.9.9 and will reconnect by itself."),
      ).toBeTruthy();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("surfaces a refusal as an alert carrying the server's sentence", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          errId: "e1",
          code: "NODE_UP_TO_DATE",
          message: "This node is already running 9.9.9, the newest release this server can offer",
          statusCode: 409,
        }),
        { status: 409 },
      )) as typeof globalThis.fetch;
    try {
      mount(node({ agentVersion: "9.9.9" }));
      fireEvent.click(screen.getByRole("button", { name: "Update to latest" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("already running 9.9.9");
    } finally {
      globalThis.fetch = original;
    }
  });
});
