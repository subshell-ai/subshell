import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocalLaunchCard } from "@/components/nodes/local-launch-card";
import type { NodeDetail, NodeShare } from "@/types/node";

/**
 * The settings-page local-launch switch (spec 2026-08-31 §10): visible only
 * when the caller can manage `local` (server-derived `canManage` — no client
 * admin re-derivation), and the PUT body is read-modify-write over the node
 * detail's embedded `shares`: only the Everyone row is added/dropped, every
 * per-user grant survives both directions.
 */
function localNode(overrides: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "local",
    name: "this host",
    kind: "local",
    os: "linux",
    arch: "x64",
    hostname: "host",
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    access: "owner",
    canManage: true,
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    shares: [],
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body?: string;
}

function mockFetch(node: NodeDetail | null) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (url.pathname === "/api/nodes/local" && method === "GET") {
      if (node === null) return Promise.resolve(new Response(JSON.stringify({ message: "gone" }), { status: 404 }));
      return Promise.resolve(new Response(JSON.stringify(node)));
    }
    return Promise.resolve(new Response(JSON.stringify({ shares: [] })));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/**
 * A live shares store: the GET detail echoes the CURRENT grant set and the PUT
 * replaces it, so the switch reflects a toggle's refetch instead of a frozen
 * fixture — the only way to exercise both directions (and the read-modify-
 * write carry-over) in one render.
 */
function mockLiveFetch(initialShares: Partial<NodeShare>[]) {
  const calls: Call[] = [];
  let shares = [...initialShares];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (url.pathname === "/api/nodes/local" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(localNode({ shares: shares as NodeShare[] }))));
    }
    if (url.pathname === "/api/nodes/local/shares" && method === "PUT") {
      shares = JSON.parse(String(init?.body)).shares;
      return Promise.resolve(new Response(JSON.stringify({ shares })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** PUT bodies sort null (Everyone) first, so both directions compare stably. */
function putBodies(calls: Call[]) {
  return calls
    .filter((c) => c.method === "PUT" && c.url === "/api/nodes/local/shares")
    .map((c) =>
      (JSON.parse(String(c.body)).shares as { granteeUserId: string | null; permission: string }[]).sort((a, b) =>
        (a.granteeUserId ?? "").localeCompare(b.granteeUserId ?? ""),
      ),
    );
}

// The card renders a `<Link>` (a router context is required) — the same
// minimal memory-router wrapper the session-actions-menu test uses.
function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <LocalLaunchCard />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("LocalLaunchCard", () => {
  it("shows ON when the Everyone/edit grant is present, and PUTs the empty set when turned off", async () => {
    const { calls, restore } = mockFetch(
      localNode({ shares: [{ id: "s1", granteeUserId: null, granteeName: "Everyone", permission: "edit" }] }),
    );
    try {
      renderCard();
      const toggle = await screen.findByRole("switch");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(putBodies(calls)[0]).toEqual([]);
      });
    } finally {
      restore();
    }
  });

  it("shows OFF without the Everyone/edit row, and PUTs exactly that row when turned on", async () => {
    const { calls, restore } = mockFetch(localNode({ shares: [] }));
    try {
      renderCard();
      const toggle = await screen.findByRole("switch");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(putBodies(calls)[0]).toEqual([{ granteeUserId: null, permission: "edit" }]);
      });
    } finally {
      restore();
    }
  });

  it("preserves per-user grants in both directions (read-modify-write, order-insensitive)", async () => {
    const { calls, restore } = mockLiveFetch([
      { granteeUserId: null, permission: "edit" },
      { granteeUserId: "userB", permission: "view" },
    ]);
    try {
      renderCard();
      const toggle = await screen.findByRole("switch");
      expect(toggle.getAttribute("aria-checked")).toBe("true");

      // OFF: drops ONLY the Everyone row — userB's view grant rides along.
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(putBodies(calls)[0]).toEqual([{ granteeUserId: "userB", permission: "view" }]);
      });
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

      // ON: reinstalls the Everyone row WITHOUT losing userB.
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(putBodies(calls)).toHaveLength(2);
        expect(putBodies(calls)[1]).toEqual([
          { granteeUserId: null, permission: "edit" },
          { granteeUserId: "userB", permission: "view" },
        ]);
      });
    } finally {
      restore();
    }
  });

  it("disables the toggle while the grant set is unknown, so no []-draft PUT can wipe shares", async () => {
    const { calls, restore } = mockFetch(localNode({ shares: undefined }));
    try {
      renderCard();
      const toggle = await screen.findByRole("switch");
      // Base UI's span-root carries disabled as `aria-disabled` (no native attr).
      expect(toggle.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(toggle);
      // Give any (wrongly) queued mutation a chance to fire before asserting.
      await new Promise((r) => setTimeout(r, 50));
      expect(putBodies(calls)).toEqual([]);
    } finally {
      restore();
    }
  });

  it("stays hidden for a viewer who cannot manage local", async () => {
    const { restore } = mockFetch(localNode({ access: "edit", canManage: false }));
    try {
      renderCard();
      await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
      expect(screen.queryByText("Launch on this host")).toBeNull();
    } finally {
      restore();
    }
  });

  it("stays hidden when local is invisible outright (404)", async () => {
    const { restore } = mockFetch(null);
    try {
      renderCard();
      await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
      expect(screen.queryByText("Launch on this host")).toBeNull();
    } finally {
      restore();
    }
  });
});
