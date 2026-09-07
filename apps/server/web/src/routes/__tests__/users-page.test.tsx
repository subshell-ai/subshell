import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/users";

/**
 * The `/users` page's admin gate and the service-account row.
 *
 * The gate is presentation, never the boundary — every management endpoint is
 * `requireAdmin` server-side. But a page that renders role selects to a
 * non-admin invites them to try, and a page that renders them on the `system`
 * account offers a control the server refuses by design. Both are the kind of
 * thing that regresses silently.
 */
const SYSTEM_ID = "sys-1";
const MEMBER_ID = "mem-1";

function roster(viewerIsAdmin: boolean) {
  return {
    viewerIsAdmin,
    users: [
      { id: SYSTEM_ID, email: "system@subshell.local", role: "user", createdAt: null, manageable: false },
      { id: MEMBER_ID, email: "dana@example.com", role: "user", createdAt: null, manageable: true },
    ],
  };
}

function mockFetch(viewerIsAdmin: boolean) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/users") return Promise.resolve(new Response(JSON.stringify(roster(viewerIsAdmin))));
    if (url.pathname === "/api/audit") return Promise.resolve(new Response(JSON.stringify({ events: [] })));
    // The page also asks better-auth who the viewer is.
    return Promise.resolve(new Response(JSON.stringify({ user: { id: "me" } })));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const usersRoute = Route.update({
    id: "/users",
    path: "/users",
    getParentRoute: () => rootRoute,
  } as any);
  const router = createRouter({
    routeTree: rootRoute.addChildren([usersRoute]),
    history: createMemoryHistory({ initialEntries: ["/users"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe("/users page", () => {
  let restore: () => void = () => {};
  afterEach(() => {
    restore();
    cleanup();
  });

  it("offers management controls to an admin", async () => {
    restore = mockFetch(true);
    renderPage();
    await waitFor(() => expect(screen.getByText("dana@example.com")).toBeDefined());
    expect(screen.getByRole("combobox", { name: "Role for dana@example.com" })).toBeDefined();
  });

  it("offers a non-admin the roster and NOTHING to change", async () => {
    restore = mockFetch(false);
    renderPage();
    await waitFor(() => expect(screen.getByText("dana@example.com")).toBeDefined());
    expect(screen.queryByRole("combobox", { name: /^Role for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /reset password/i })).toBeNull();
  });

  it("gives the service account no controls, even for an admin", async () => {
    // Server-flagged rather than matched on the address here, so the two sides
    // cannot disagree about which account it is.
    restore = mockFetch(true);
    renderPage();
    await waitFor(() => expect(screen.getByText("system@subshell.local")).toBeDefined());
    expect(screen.getByText("Service account")).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Role for system@subshell.local" })).toBeNull();
  });
});
