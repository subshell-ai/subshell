import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import type { AdminStatus } from "@/hooks/use-admin-status";
import { Route } from "@/routes/settings_.status";
import type { ServerDeployment } from "@/types/server-deployment";

/** A healthy instance; each test overrides only what it is about. */
const HEALTHY: AdminStatus = {
  versions: { server: "1.5.0", nodeProtocol: 4, minAgent: "0.3.0", bun: "1.4.0" },
  runtime: {
    uptimeSeconds: 90_061,
    bootedAt: "2026-09-03T12:00:00.000Z",
    pid: 4242,
    os: "darwin",
    arch: "arm64",
    hostname: "studio",
    production: true,
    memoryRssBytes: 11_370_496,
    memoryHeapUsedBytes: 556_032,
    listenHost: "127.0.0.1",
    listenPort: 3080,
    appBaseUrl: "https://subshell.example",
    staticSource: "embedded",
    databasePath: "/var/lib/subshell/subshell.db",
    databaseBytes: 2_097_152,
    tmuxPath: "/opt/homebrew/bin/tmux",
    mcpEntrypoint: "/usr/local/bin/subshell-server mcp",
    mcpSource: "self",
  },
  inventory: {
    users: { total: 3, admins: 1 },
    subshells: { total: 42, running: 2 },
    nodes: { total: 5, online: 3, needingUpdate: [] },
    workspaces: 4,
    channels: 6,
    presets: 7,
  },
  security: {
    registrationsOpen: false,
    emergencyLoginActive: false,
    usingPlaceholderSecret: false,
    systemKeys: { total: 2, active: 1 },
  },
  generatedAt: "2026-09-04T12:00:00.000Z",
};

interface Call {
  url: string;
}

/**
 * Both of the page's reads, each failable on its own: `admin/status` is the
 * instance, `admin/server` is the deployment view the Locations card needs.
 *
 * @param status - the instance status, or null to 403 that route
 * @param viewerIsAdmin - what `/api/settings/public` reports
 * @param deployment - the deployment view, or null to 403 that route
 */
function mockFetch(
  status: AdminStatus | null,
  viewerIsAdmin: boolean,
  deployment: ServerDeployment | null = deploymentView(),
) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ url: url.pathname });
    if (url.pathname === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify({ viewerIsAdmin, serverVersion: "1.5.0" })));
    }
    if (url.pathname === "/api/admin/status") {
      if (status === null) return Promise.resolve(new Response("forbidden", { status: 403 }));
      return Promise.resolve(new Response(JSON.stringify(status)));
    }
    if (url.pathname === "/api/admin/server") {
      if (deployment === null) return Promise.resolve(new Response("forbidden", { status: 403 }));
      return Promise.resolve(new Response(JSON.stringify(deployment)));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  // Re-parented onto a test root, as in nodes-detail.test.tsx.
  const statusRoute = Route.update({
    id: "/settings_/status",
    path: "/settings/status",
    getParentRoute: () => rootRoute,
  } as any);
  const router = createRouter({
    routeTree: rootRoute.addChildren([statusRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/status"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("Server status page", () => {
  it("renders versions and inventory for an admin", async () => {
    const { restore } = mockFetch(HEALTHY, true);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("1.5.0")).toBeDefined());
      expect(screen.getByText("v4")).toBeDefined(); // node protocol
      expect(screen.getByText("0.3.0")).toBeDefined(); // agent floor
      expect(screen.getByText("2 running")).toBeDefined();
      expect(screen.getByText("3 online")).toBeDefined();
      expect(screen.getByText("1d 1h")).toBeDefined(); // uptime, formatted
    } finally {
      restore();
    }
  });

  it("does NOT request the admin endpoint for a non-admin", async () => {
    // The gate that matters: the endpoint 403s a non-admin, so mounting the
    // page must not fire a doomed request — the same rule /settings applies.
    const { calls, restore } = mockFetch(null, false);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText(/for instance admins/)).toBeDefined());
      expect(calls.some((c) => c.url === "/api/admin/status")).toBe(false);
      expect(calls.some((c) => c.url === "/api/admin/server")).toBe(false);
    } finally {
      restore();
    }
  });

  it("gives a non-admin NO control that refetches — refetch() ignores the `enabled` gate", async () => {
    // The gate only covers the AUTOMATIC fetch. `refetch()` calls straight
    // through to the fetcher regardless of `enabled`, so any refetching
    // control rendered outside the admin branch would hand a non-admin a
    // one-click 403 that renders nothing (the error banner is inside that
    // branch). Retry is the only such control left — the header Refresh was
    // removed as redundant with the poll — so it is what this pins; the
    // button name is checked too, so reintroducing one outside the branch
    // fails here rather than silently passing.
    const { calls, restore } = mockFetch(null, false);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText(/for instance admins/)).toBeDefined());
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
      expect(calls.some((c) => c.url === "/api/admin/status")).toBe(false);
    } finally {
      restore();
    }
  });

  it("names the agents below the floor, so a refused node is explicable", async () => {
    const { restore } = mockFetch(
      {
        ...HEALTHY,
        inventory: {
          ...HEALTHY.inventory,
          nodes: { total: 5, online: 3, needingUpdate: [{ id: "n1", name: "old-mac", agentVersion: "0.2.1" }] },
        },
      },
      true,
    );
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText(/old-mac · 0\.2\.1/)).toBeDefined());
    } finally {
      restore();
    }
  });

  it("badges the two failure states that otherwise hide until a user hits them", async () => {
    // No tmux = every local pane launch fails; unresolved MCP = every subshell
    // create 500s. Both are silent until someone clicks something.
    const { restore } = mockFetch(
      { ...HEALTHY, runtime: { ...HEALTHY.runtime, tmuxPath: null, mcpEntrypoint: null, mcpSource: null } },
      true,
    );
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText(/subshells cannot launch on the server/)).toBeDefined());
      expect(screen.getByText(/creating a subshell will fail/)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("renders the Locations card from the deployment view", async () => {
    // The paths live only on `GET /api/admin/server`; this page mounts that
    // read beside admin/status precisely so the card can be here.
    const { restore } = mockFetch(HEALTHY, true);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("Locations")).toBeDefined());
      expect(screen.getByText("/c/config.env")).toBeDefined();
      expect(screen.getByText("/c")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("states the database SIZE in Runtime, and the path only in Locations", async () => {
    // The two cards share a page now, so the path stated twice — once
    // copyable, once not — was the duplication this move removed.
    const { restore } = mockFetch(HEALTHY, true);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("Database size")).toBeDefined());
      expect(screen.getByText("2.0 MiB")).toBeDefined();
      // The two fixtures name the database differently ON PURPOSE, and both
      // halves are asserted: Runtime's own path is gone, and Locations states
      // the deployment view's. Aligning the strings would make the negative
      // assertion vacuous — one string absent proves nothing about which card
      // dropped it.
      expect(screen.queryByText(/\/var\/lib\/subshell\/subshell\.db/)).toBeNull();
      expect(screen.getByText("/c/subshell.db")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("keeps the instance cards when only the deployment read fails", async () => {
    // Two routes, two failures: one must not take the other's cards down.
    const { restore } = mockFetch(HEALTHY, true, null);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("Could not load this server's deployment.")).toBeDefined());
      expect(screen.getByText("Runtime")).toBeDefined();
      expect(screen.queryByText("Locations")).toBeNull();
      expect(screen.queryByText("Could not load the instance status.")).toBeNull();
    } finally {
      restore();
    }
  });

  it("keeps the Locations card when only the instance read fails", async () => {
    // The other direction, and the one the route's unusual JSX exists for:
    // `LocationsCard` sits OUTSIDE the `status` branch, so a 403 on
    // admin/status must leave the paths on the page. Nesting it back inside
    // that branch passes every other test in this file.
    const { restore } = mockFetch(null, true);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("Could not load the instance status.")).toBeDefined());
      expect(screen.getByText("Locations")).toBeDefined();
      expect(screen.getByText("/c/config.env")).toBeDefined();
      expect(screen.queryByText("Versions")).toBeNull();
      expect(screen.queryByText("Runtime")).toBeNull();
      expect(screen.queryByText("Inventory")).toBeNull();
      expect(screen.queryByText("Security")).toBeNull();
      expect(screen.queryByText("Could not load this server's deployment.")).toBeNull();
    } finally {
      restore();
    }
  });

  it("flags an armed break-glass password and a placeholder auth secret", async () => {
    const { restore } = mockFetch(
      {
        ...HEALTHY,
        security: { ...HEALTHY.security, emergencyLoginActive: true, usingPlaceholderSecret: true },
      },
      true,
    );
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("armed")).toBeDefined());
      expect(screen.getByText("placeholder")).toBeDefined();
    } finally {
      restore();
    }
  });
});
