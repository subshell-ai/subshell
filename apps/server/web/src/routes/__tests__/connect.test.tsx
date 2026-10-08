import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ConnectPage, Route } from "../connect";

/**
 * Contract 8: the route exists at /connect and opens with a real page
 * heading. The panel itself is pinned by `components/connect/`; the nav
 * entry by the sidebar tests; the e2e spec lands here end-to-end.
 */
afterEach(cleanup);

it("declares the route with a component (the path binds in the generated tree)", () => {
  // createFileRoute attaches `path`/`id` when the router builds the tree from
  // routeTree.gen.ts; the loadable unit here is the options object, and the
  // e2e spec lands on the URL.
  expect(typeof Route.options.component).toBe("function");
});

it("opens on the Connect heading over the panel", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = path === "/api/nodes" ? { nodes: [] } : { saved: [], recent: [], defaultNodeId: null };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({ getParentRoute: () => rootRoute, path: "/connect", component: ConnectPage }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/connect"] }),
      defaultPreload: false,
    });
    await router.load();
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(await screen.findByRole("heading", { name: "Connect" })).toBeDefined();
    expect(screen.getByPlaceholderText("Choose or type a destination")).toBeDefined();
  } finally {
    globalThis.fetch = original;
  }
});
