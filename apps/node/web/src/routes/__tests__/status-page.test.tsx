import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusPage } from "../index";

/**
 * The status page is the §4.6 out-of-band compare's LOCAL half (spec
 * 2026-10-08): the check happens on the two machines' OWN loopback
 * dashboards, because a fingerprint read off the plane proves nothing about
 * the machine behind it. So this page must render the trust card, fed from
 * the agent view's own `sshTrust` (the node-local key files, `stale: false`
 * by definition on the machine's own surface).
 *
 * The fetcher is stubbed: the page's `useNode("self")` speaks the node's
 * mirror of `/api/nodes/:id`, and `NodeLogCard` polls `/logs` even though
 * this suite is about the trust block, not the tail.
 */

const FP_OWN_SIGN = `SHA256:${"A".repeat(43)}`;
const FP_OWN_ENC = `SHA256:${"B".repeat(43)}`;
const FP_PEER_SIGN = `SHA256:${"C".repeat(43)}`;
const FP_PEER_ENC = `SHA256:${"D".repeat(43)}`;
const PEER_ID = "0f8e2c1a-0000-4000-8000-000000000001";

/** This machine answering `GET /api/nodes/self` about itself, as `view.ts` shapes it. */
function localView(): NodeDetail {
  return {
    id: "self",
    name: "devbox",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "devbox",
    status: "online",
    lastSeenAt: "2026-10-08T10:00:00.000Z",
    agentVersion: "1.0.0",
    protocolVersion: 18,
    // The loopback view's standing answers: no viewer identity exists here,
    // and the human at this machine outranks any web grant (view.ts).
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
    sshEnabled: true,
    held: null,
    serverUrl: "http://127.0.0.1:3080",
    // No `runtime`: the page then skips the Runtime/Service cards, and this
    // suite stays about the trust block. The trust card needs no runtime.
    sshTrust: {
      own: { signing: FP_OWN_SIGN, encryption: FP_OWN_ENC },
      peers: [{ nodeId: PEER_ID, signing: FP_PEER_SIGN, encryption: FP_PEER_ENC }],
      stale: false,
    },
    runningSubshells: 0,
  };
}

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = url.includes("/logs") ? { text: "", nextByte: 0, size: 0, truncated: false } : localView();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <StatusPage />
    </QueryClientProvider>,
  );
}

describe("status page — machine trust", () => {
  it("renders own and peer fingerprints from the agent view, unmarked (the local truth is never stale)", async () => {
    renderPage();
    expect(await screen.findByText("Machine trust")).toBeTruthy();
    expect(screen.getByText(FP_OWN_SIGN)).toBeTruthy();
    expect(screen.getByText(FP_OWN_ENC)).toBeTruthy();
    expect(screen.getByText(`Peer ${PEER_ID}`)).toBeTruthy();
    expect(screen.getByText(FP_PEER_SIGN)).toBeTruthy();
    expect(screen.getByText(FP_PEER_ENC)).toBeTruthy();
    // No stale marking on the machine's own surface: this page is the local
    // truth, never a mirror of a departed connection.
    expect(screen.queryByText(/stale/i)).toBeNull();
  });

  it("renders no trust card when the node's own store reported no block", async () => {
    // The unreadable-pin-set case: `view.ts` costs the FIELD, never the page.
    const base = localView();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = url.includes("/logs")
        ? { text: "", nextByte: 0, size: 0, truncated: false }
        : { ...base, sshTrust: undefined };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    renderPage();
    await screen.findByText("This machine");
    expect(screen.queryByText("Machine trust")).toBeNull();
  });
});
