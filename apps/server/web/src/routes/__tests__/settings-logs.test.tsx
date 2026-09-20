import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { Route } from "@/routes/settings_.logs";

/** One trail row — the locator for "the audit tab rendered". */
const EVENT = {
  id: "ev-1",
  actorUserId: "admin-1",
  action: "user.create",
  targetType: "user",
  targetId: "0123456789abcdef",
  metadata: {},
  createdAt: "2026-09-11T10:00:00.000Z",
};

/**
 * Stubs the four routes this page can ask for and records the pathnames.
 * `/api/admin/status` deliberately is NOT stubbed with data: the page must
 * never ask it, and an unexpected call would be visible in `calls`.
 */
function mockFetch(viewerIsAdmin: boolean) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname);
    if (url.pathname === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify({ viewerIsAdmin })));
    }
    if (url.pathname === "/api/admin/server") {
      return Promise.resolve(new Response(JSON.stringify(deploymentView())));
    }
    if (url.pathname === "/api/admin/server/logs") {
      return Promise.resolve(
        new Response(JSON.stringify({ lines: [], file: "/c/logs/server.log", bytes: 0, capBytes: 204_800 })),
      );
    }
    if (url.pathname === "/api/audit") {
      return Promise.resolve(new Response(JSON.stringify([EVENT])));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderPage(initialEntries = "/settings/logs") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  // Re-parented onto a test root, as in server-status.test.tsx.
  const logsRoute = Route.update({
    id: "/settings_/logs",
    path: "/settings/logs",
    getParentRoute: () => rootRoute,
  } as any);
  const router = createRouter({
    routeTree: rootRoute.addChildren([logsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntries] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

afterEach(cleanup);

describe("Logs page", () => {
  it("gives a non-admin the guidance sentence and NO doomed request", async () => {
    // The gate every admin page copies: `undefined`/false counts as not-admin
    // for the queries' `enabled`, and no refetching control renders outside
    // the admin branch. The tabs gate too — a member should not even see the
    // System/Audit switch.
    const { calls, restore } = mockFetch(false);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText(/Instance settings are for admins/)).toBeDefined());
      expect(calls).not.toContain("/api/admin/server");
      expect(calls).not.toContain("/api/admin/server/logs");
      expect(calls).not.toContain("/api/audit");
      expect(screen.queryByRole("button", { name: "System log" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("opens on the System tab without a `?tab=`, and asks for neither audit nor status", async () => {
    const { calls, restore } = mockFetch(true);
    try {
      renderPage();
      await waitFor(() => expect(pressed("System log")).toBe("true"));
      expect(pressed("Audit log")).toBe("false");
      expect(calls).toContain("/api/admin/server");
      expect(calls).toContain("/api/admin/server/logs");
      expect(calls).not.toContain("/api/audit");
      expect(calls).not.toContain("/api/admin/status");
    } finally {
      restore();
    }
  });

  it("`?tab=audit` renders the trail and never probes the deployment", async () => {
    // The spawn-stall gate: every `/api/admin/server` read is a synchronous
    // port-and-service-manager probe, so the audit tab must not mount it.
    const { calls, restore } = mockFetch(true);
    try {
      renderPage("/settings/logs?tab=audit");
      await waitFor(() => expect(screen.getByText("user.create")).toBeDefined());
      expect(calls).toContain("/api/audit");
      expect(calls).not.toContain("/api/admin/server");
      expect(calls).not.toContain("/api/admin/server/logs");
    } finally {
      restore();
    }
  });

  it("switches tabs by press, and back to System with no re-probe storm", async () => {
    const { calls, restore } = mockFetch(true);
    try {
      renderPage();
      await waitFor(() => expect(pressed("System log")).toBe("true"));
      fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
      await waitFor(() => expect(screen.getByText("user.create")).toBeDefined());
      expect(pressed("System log")).toBe("false");
      fireEvent.click(screen.getByRole("button", { name: "System log" }));
      await waitFor(() => expect(pressed("System log")).toBe("true"));
      // The deployment read happened once for the opening tab; navigating
      // away and back hits the same query key, it does not mint a new probe
      // per switch.
      expect(calls.filter((c) => c === "/api/admin/server").length).toBeLessThanOrEqual(2);
    } finally {
      restore();
    }
  });
});
