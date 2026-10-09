import { afterEach, describe, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { SshTrustSection } from "@/components/ssh/trust-section";

/**
 * The trust section of a node's page (spec 2026-10-08 §4.5-§4.6): the shared
 * machine trust card (owner/`edit` on an agent node, never `view`, never
 * `local`), the plane's honesty line (this rendering is for DISPLAY only,
 * the §4.6 check happens on the two machines' own dashboards), and the
 * owner-only re-pair act on each pinned peer. The re-pair route does not
 * exist on the plane yet (T15 report flags it), so the act is DRAWN disabled
 * with its reason; a button that always fails would lie.
 */

const FP_OWN_SIGN = `SHA256:${"A".repeat(43)}`;
const FP_OWN_ENC = `SHA256:${"B".repeat(43)}`;
const FP_PEER_SIGN = `SHA256:${"C".repeat(43)}`;
const FP_PEER_ENC = `SHA256:${"D".repeat(43)}`;
const PEER_ID = "0f8e2c1a-0000-4000-8000-000000000001";

function node(over: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "node1",
    name: "vault",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "vault",
    status: "online",
    lastSeenAt: null,
    agentVersion: "1.0.0",
    protocolVersion: 18,
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
    sshEnabled: true,
    held: null,
    sshTrust: {
      own: { signing: FP_OWN_SIGN, encryption: FP_OWN_ENC },
      peers: [{ nodeId: PEER_ID, signing: FP_PEER_SIGN, encryption: FP_PEER_ENC }],
      stale: false,
    },
    ...over,
  };
}

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restores.splice(0)) undo();
});

function renderSection(n: NodeDetail) {
  const original = globalThis.fetch;
  restores.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ nodes: [{ id: PEER_ID, name: "desk" }] }), {
      status: 200,
    })) as typeof globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SshTrustSection node={n} />
    </QueryClientProvider>,
  );
}

describe("SshTrustSection", () => {
  it("renders nothing for a view grantee, even against a payload that arrived anyway", () => {
    const { container } = renderSection(node({ access: "view", canManage: false }));
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on local", () => {
    const { container } = renderSection(node({ kind: "local" }));
    expect(container.firstChild).toBeNull();
  });

  it("renders the shared card for an edit grantee but no re-pair act", () => {
    renderSection(node({ access: "edit", canManage: false }));
    expect(screen.getByText("Machine trust")).toBeDefined();
    expect(screen.getByText(FP_PEER_SIGN)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Re-pair/ })).toBeNull();
  });

  it("offers the owner a re-pair per pinned peer, disabled while the plane cannot answer", async () => {
    renderSection(node());
    // The peer label settles once the machine-name read lands (names, never ids).
    const button = (await screen.findByRole("button", { name: "Re-pair desk" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("does not offer re-pairing");
  });

  it("names the audit consequence: a re-pair replaces the stored pin, audited by peer", () => {
    renderSection(node());
    expect(screen.getByText(/replaces the stored pin/)).toBeDefined();
    expect(screen.getByText(/names the peer/)).toBeDefined();
  });

  it("marks its own rendering for display only, pointing at the two dashboards", () => {
    renderSection(node());
    expect(screen.getByText(/for display only/)).toBeDefined();
    expect(screen.getByText(/own dashboard/)).toBeDefined();
  });
});
