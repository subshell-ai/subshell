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

/**
 * Rerenders with a DIFFERENT node prop on the SAME QueryClient — which is
 * what navigating `/nodes/a` to `/nodes/b` does to the mounted card. A fresh
 * client would remount the hook and reset it by accident, proving nothing.
 */
function withNode(client: QueryClient, n: NodeDetail) {
  return (
    <QueryClientProvider client={client}>
      <NodeUpdateCard node={n} />
    </QueryClientProvider>
  );
}

function refused(to: string) {
  return new Response(
    JSON.stringify({
      errId: "e1",
      code: "NODE_UP_TO_DATE",
      message: `This node is already running ${to}, the newest release this server can offer`,
      statusCode: 409,
    }),
    { status: 409 },
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
      // Let the 202 land and the mutation settle before unmount, or React
      // logs an act() warning for the setState the resolution fires.
      await screen.findByText(/Update accepted/);
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

  it("retires the refusal when the page moves to another node and back", async () => {
    // TanStack reuses this route component across `:id` changes and the
    // mutation state lives in the CARD's hook, so without a reset on node
    // change, coming back to the failed node re-shows the stale refusal as
    // though the press had just happened. (Review C1.)
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) => refused("9.9.9")) as typeof globalThis.fetch;
    try {
      const a = node({ id: "a", name: "alpha", agentVersion: "9.9.9" });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const { rerender } = render(withNode(client, a));
      fireEvent.click(screen.getByRole("button", { name: "Update to latest" }));
      await screen.findByRole("alert");
      rerender(withNode(client, node({ id: "b", name: "beta" })));
      expect(screen.queryByRole("alert")).toBeNull();
      rerender(withNode(client, { ...a }));
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("drops the accepted line once the node reports back", async () => {
    // The line is a transition announcement; once the node's own facts answer
    // the question, keeping "installing 9.9.9" up would let a pane deleted
    // mid-flight leave it hanging under a node simply running something else.
    // (Review I4.)
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
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const { rerender } = render(withNode(client, node({ status: "offline" })));
      fireEvent.click(screen.getByRole("button", { name: "Update to latest" }));
      await screen.findByText(/Update accepted/);
      rerender(withNode(client, node({ status: "online", agentVersion: "9.9.9" })));
      expect(screen.queryByText(/Update accepted/)).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});
