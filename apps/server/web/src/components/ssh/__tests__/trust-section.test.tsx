import { afterEach, describe, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SshTrustSection } from "@/components/ssh/trust-section";

/**
 * The trust section of a node's page (spec 2026-10-08 §4.5-§4.6): the shared
 * machine trust card (owner/`edit` on an agent node, never `view`, never
 * `local`), the plane's honesty line (this rendering is for DISPLAY only,
 * the §4.6 check happens on the two machines' own dashboards), and the
 * owner-only re-pair act on each pinned peer (Task 17: the route exists now,
 * so the button is LIVE - it POSTs the repair for exactly its own peer and
 * reports the outcome on itself).
 *
 * The gate pinned here is the EXACT owner: the server resolves an admin (or
 * any grantee) on a foreign agent to `access: "edit"`, and the edit-grantee
 * case below is the same shape the admin sees - no act, only the card.
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

interface RecordedCall {
  url: string;
  method: string;
}

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restores.splice(0)) undo();
});

/**
 * Stub fetch: the node-name read answers the machine list (names, never ids,
 * on the button), and every other call - the repair POST - is recorded and
 * answered with `mode`.
 */
function renderSection(n: NodeDetail, mode: "ok" | "fail" = "ok", admin = false) {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  restores.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.includes("/api/settings/public"))
      return new Response(JSON.stringify({ viewerIsAdmin: admin }));
    if (method === "GET") {
      return new Response(JSON.stringify({ nodes: [{ id: PEER_ID, name: "desk" }] }), { status: 200 });
    }
    calls.push({ url, method });
    if (mode === "ok") return new Response(JSON.stringify({ repaired: true }), { status: 200 });
    return new Response(
      JSON.stringify({
        errId: "e1",
        code: "NODE_OFFLINE",
        message: "That machine has no live connection right now.",
        statusCode: 409,
      }),
      { status: 409 },
    );
  }) as typeof globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SshTrustSection node={n} />
    </QueryClientProvider>,
  );
  return { ...view, calls };
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

  it("lets an admin inspect and repair the server's peer pin store", async () => {
    const { calls } = renderSection(node({ id: "local", kind: "local", access: "edit" }), "ok", true);
    const button = await screen.findByRole("button", { name: "Re-pair desk" });
    expect(screen.getByText("Machine trust")).toBeTruthy();
    fireEvent.click(button);
    await screen.findByText("Pin replaced for desk.");
    expect(calls[0]?.url).toBe(`/api/nodes/local/machine-pins/${PEER_ID}/repair`);
  });

  it("keeps a member out of server pins even if their payload wrongly claims canManage", () => {
    const { container } = renderSection(node({ id: "local", kind: "local", canManage: true }), "ok", false);
    expect(container.firstChild).toBeNull();
  });

  it("renders the shared card for an edit grantee but no re-pair act", () => {
    // An `edit` grantee AND an admin on a foreign agent both arrive here as
    // access:"edit" (the resolver ranks admins at edit, never owner): the
    // trust is read, never re-decided (§4.5 owner-only).
    renderSection(node({ access: "edit", canManage: false }));
    expect(screen.getByText("Machine trust")).toBeDefined();
    expect(screen.getByText(FP_PEER_SIGN)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Re-pair/ })).toBeNull();
  });

  it("offers the owner a live re-pair per pinned peer that posts the repair for exactly its peer", async () => {
    const { calls } = renderSection(node());
    // The peer label settles once the machine-name read lands (names, never ids).
    const button = (await screen.findByRole("button", { name: "Re-pair desk" })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByText(/Pin replaced for desk/);
    expect(calls).toEqual([{ url: `/api/nodes/node1/machine-pins/${PEER_ID}/repair`, method: "POST" }]);
  });

  it("renders a refusal on the button that failed, in the machine's words, without key material", async () => {
    renderSection(node(), "fail");
    const button = (await screen.findByRole("button", { name: "Re-pair desk" })) as HTMLButtonElement;
    fireEvent.click(button);
    const note = await screen.findByText(/no live connection/);
    expect(note.className).toContain("text-destructive");
    expect(screen.queryByText(/Pin replaced/)).toBeNull();
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
