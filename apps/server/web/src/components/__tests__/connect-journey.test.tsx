import { afterEach, describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { SSH_ERROR_DESCRIPTIONS } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectJourney } from "@/components/connect/connect-journey";

/**
 * The wizard's refusal and empty-state branches (wave-2 review M2): machines
 * the caller does not OWN never appear; ineligible machines are shown disabled
 * with the reason; a failed config read is never the empty-list copy; and a
 * named resolve refusal renders the SHIPPED sentence from
 * `SSH_ERROR_DESCRIPTIONS` plus the blocked settings, never the wire code.
 */

const BASE: Node = {
  id: "n1",
  name: "Laptop",
  kind: "agent",
  os: "linux",
  arch: "x86_64",
  hostname: "laptop-01",
  status: "online",
  lastSeenAt: new Date().toISOString(),
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
  held: null,
};

interface JourneyFetchOptions {
  nodes?: Node[];
  aliases?: string[];
  /** Set to make discovery answer non-OK (the failure-vs-empty branch). */
  discoveryStatus?: number;
  resolveBody?: unknown;
}

function mockFetch(over: JourneyFetchOptions = {}) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/nodes") return json({ nodes: over.nodes ?? [] });
    if (url.pathname === "/api/presets") return json([]);
    if (url.pathname === "/api/ssh-runtime/discovery") {
      if (over.discoveryStatus !== undefined && over.discoveryStatus !== 200) {
        return json({ message: "The node refused the read." }, over.discoveryStatus);
      }
      return json({ aliases: over.aliases ?? [], includeCycle: false, truncated: false });
    }
    if (url.pathname === "/api/ssh-runtime/resolve")
      return json(over.resolveBody ?? { accepted: false, code: "config_missing", settings: [] });
    return json({});
  }) as typeof fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Flush pending query/effect updates inside act() (the repo-wide settle pattern). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** The journey is mounted as the index route of a throwaway router (it calls useNavigate). */
async function renderJourney(prefill: { nodeId: string; alias: string } | null = null): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ConnectJourney prefill={prefill} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
}

afterEach(cleanup);

describe("ConnectJourney machine step", () => {
  it("an empty owned-machine list names the need and the remedy, not a broken list", async () => {
    const m = mockFetch({ nodes: [{ ...BASE, id: "other", access: "edit" }] });
    try {
      await renderJourney();
      expect(screen.getByText(/This needs one of your own enrolled machines/)).toBeTruthy();
      // The shared machine is NOT listed: broker rights are ownership, not access.
      expect(screen.queryByRole("button", { name: /Laptop/ })).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("ineligible machines are shown DISABLED with the reason, never hidden", async () => {
    const m = mockFetch({
      nodes: [
        BASE,
        { ...BASE, id: "n2", name: "Docking", status: "offline" },
        { ...BASE, id: "n3", name: "Workshop", maintenance: true },
      ],
    });
    try {
      await renderJourney();
      expect(screen.getByRole("button", { name: /Laptop/ }).hasAttribute("disabled")).toBe(false);
      const offline = screen.getByRole("button", { name: /Docking/ });
      expect(offline.hasAttribute("disabled")).toBe(true);
      expect(offline.textContent).toContain("offline");
      const maint = screen.getByRole("button", { name: /Workshop/ });
      expect(maint.hasAttribute("disabled")).toBe(true);
      expect(maint.textContent).toContain("in maintenance");
    } finally {
      m.restore();
    }
  });
});

describe("ConnectJourney host step", () => {
  it("an empty alias list says so; a failed read is never that sentence", async () => {
    const m = mockFetch({ nodes: [BASE], aliases: [] });
    try {
      await renderJourney({ nodeId: "n1", alias: "staging" });
      expect(await screen.findByText(/No SSH host aliases were found/)).toBeTruthy();
      expect(screen.queryByText(/could not be read/)).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("a failed config read is the failure row, never the empty-list sentence", async () => {
    const m = mockFetch({ nodes: [BASE], discoveryStatus: 502 });
    try {
      await renderJourney({ nodeId: "n1", alias: "staging" });
      // The read's own error (the failure alert carries it verbatim) plus a
      // Retry; the empty copy must stay silent, that is the whole distinction.
      expect(await screen.findByText(/The node refused the read\./)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByText(/No SSH host aliases were found/)).toBeNull();
    } finally {
      m.restore();
    }
  });
});

describe("ConnectJourney review step", () => {
  it("renders the shipped sentence for a named refusal, the blocked settings, and never the wire code", async () => {
    const m = mockFetch({
      nodes: [BASE],
      aliases: ["staging"],
      resolveBody: {
        accepted: false,
        code: "unsupported_setting",
        settings: ["ProxyCommand", "LocalForward"],
      },
    });
    try {
      await renderJourney();
      fireEvent.click(screen.getByRole("button", { name: /Laptop/ }));
      const alias = await screen.findByRole("button", { name: "staging" });
      fireEvent.click(alias);
      // The equality mapping, mirrored from the old editor: the package's own
      // sentence, rendered verbatim.
      expect(await screen.findByText(SSH_ERROR_DESCRIPTIONS.unsupported_setting)).toBeTruthy();
      expect(screen.getByText(/Blocked settings: ProxyCommand, LocalForward/)).toBeTruthy();
      // The raw wire code is not human copy (finding I1): nothing renders it.
      expect(screen.queryByText(/unsupported_setting/)).toBeNull();
      // The refusal leaves Connect inert: the review has nothing to open.
      expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    } finally {
      m.restore();
    }
  });

  it("an accepted resolve shows the destination and the connecting account", async () => {
    const m = mockFetch({
      nodes: [BASE],
      aliases: ["staging"],
      resolveBody: {
        accepted: true,
        snapshot: { alias: "staging", host: "app-02", user: "deploy", port: 22, identityFiles: [] },
        connectingAccount: "theo",
      },
    });
    try {
      await renderJourney();
      fireEvent.click(screen.getByRole("button", { name: /Laptop/ }));
      fireEvent.click(await screen.findByRole("button", { name: "staging" }));
      expect(await screen.findByText("deploy@app-02:22")).toBeTruthy();
      expect(screen.getByText(/Laptop as theo/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(false);
    } finally {
      m.restore();
    }
  });
});
