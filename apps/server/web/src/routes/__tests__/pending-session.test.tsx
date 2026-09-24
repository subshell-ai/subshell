import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/pending";
import { setFetchRouter } from "@/test-setup";

/**
 * `/pending` asks the session before it paints the waiting card (Task 14
 * review, minor 2). A bookmarked screen, or an approval that lands while the
 * person is still sitting there, must not keep insisting "awaiting approval"
 * to someone who is signed in — the same question login asks, the same
 * answer: a session goes to `/`.
 */
function stubWires(signedIn: boolean) {
  setFetchRouter((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/auth/get-session") {
      return Promise.resolve(
        signedIn
          ? new Response(JSON.stringify({ user: { id: "u1", name: "Ada", email: "ada@example.com" } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ message: "Unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json" },
            }),
      );
    }
    if (url.pathname === "/api/settings/instance") {
      return Promise.resolve(
        new Response(JSON.stringify({ instanceName: "Test Plane", providers: [], emailSignIn: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
  return () => setFetchRouter(null);
}

function renderPending() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  // The memory-router shape the other route tests use (nodes-page-gate).
  const pendingRoute = Route.update({
    id: "/pending",
    path: "/pending",
    getParentRoute: () => rootRoute,
  } as Parameters<typeof Route.update>[0]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([pendingRoute]),
    history: createMemoryHistory({ initialEntries: ["/pending?email=ada%40example.com"] }),
    defaultPreload: false,
    // The guard's destination ("/") is deliberately outside this two-route
    // tree; the assertion reads the router's location, so silence TanStack's
    // loud default not-found page the way `main.tsx` does for the real app.
    defaultNotFoundComponent: () => null,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("/pending", () => {
  afterEach(() => {
    setFetchRouter(null);
    cleanup();
  });

  it("holds the waiting card for a signed-out visitor, with the email", async () => {
    stubWires(false);
    renderPending();
    await screen.findByText(/awaiting approval by an administrator/i);
    // The address named by the refusal travels through the search params.
    expect(screen.getByText("ada@example.com")).toBeDefined();
    expect(screen.getByText(/Sign in to Test Plane/)).toBeDefined();
  });

  it("sends a signed-in visitor to / instead of the stale waiting card", async () => {
    stubWires(true);
    const router = renderPending();
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    // Asserted at the card too, not just the address bar: the guard's point
    // is that nobody READS "awaiting approval" while they hold a session.
    expect(screen.queryByText(/awaiting approval/i)).toBeNull();
  });
});
