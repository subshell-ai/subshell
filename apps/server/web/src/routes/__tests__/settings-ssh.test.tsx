import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { Route, SshSettingsPage } from "../settings_.ssh";

/**
 * The SSH settings page opens on its three per-owner surfaces (spec
 * 2026-10-08 §8): the approval queue, the standing grants, and destination
 * trust. The cards' own behaviors are pinned in `components/ssh/`; this is
 * the page contract: heading, the three sections, and no admin gate anywhere
 * (the ledger is the caller's, every signed-in person has one).
 */
afterEach(cleanup);

it("declares the route with a component (the path binds in the generated tree)", () => {
  expect(typeof Route.options.component).toBe("function");
});

it("opens on the SSH heading over the three sections", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body =
      path === "/api/ssh/grants"
        ? { grants: [] }
        : path === "/api/ssh/grant-requests"
          ? { requests: [] }
          : path === "/api/ssh/host-pins"
            ? { pins: [] }
            : path === "/api/nodes"
              ? { nodes: [] }
              : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/ssh",
      component: SshSettingsPage,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/settings/ssh"] }),
      defaultPreload: false,
    });
    await router.load();
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "SSH" })).toBeDefined();
    expect(screen.getByText("Pending approvals")).toBeDefined();
    expect(screen.getByText("Key grants")).toBeDefined();
    expect(screen.getByText("Destination trust")).toBeDefined();
  } finally {
    globalThis.fetch = original;
  }
});
