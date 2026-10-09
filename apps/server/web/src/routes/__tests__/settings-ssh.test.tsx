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

/** Personal SSH settings expose destination trust and saved destinations. */
afterEach(cleanup);

it("declares the route with a component (the path binds in the generated tree)", () => {
  expect(typeof Route.options.component).toBe("function");
});

it("opens on the SSH heading and destination trust", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body =
      path === "/api/ssh/host-pins"
        ? { pins: [] }
        : path === "/api/ssh/saved-hosts"
          ? { saved: [], recent: [], defaultNodeId: null }
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
    expect(screen.getByText("Destination trust")).toBeDefined();
  } finally {
    globalThis.fetch = original;
  }
});
