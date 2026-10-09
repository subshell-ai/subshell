import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SshSettingsPage } from "@/routes/settings_.ssh";

const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});

test("loading and failed reads never claim an empty SSH settings ledger; retry recovers", async () => {
  let respond!: () => void;
  const gate = new Promise<void>((resolve) => {
    respond = resolve;
  });
  let failing = true;
  globalThis.fetch = (async (input: unknown) => {
    await gate;
    const path = String(input);
    if (path === "/api/nodes") return new Response(JSON.stringify({ nodes: [] }));
    if (failing) return new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 });
    return new Response(JSON.stringify({ requests: [], grants: [], pins: [] }));
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/", component: SshSettingsPage });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Loading pending approvals…")).toBeTruthy();
  expect(screen.queryByText("Nothing is waiting for an answer.")).toBeNull();
  respond();
  expect(await screen.findByText("Could not load pending approvals.")).toBeTruthy();
  expect(await screen.findByText("Could not load key grants.")).toBeTruthy();
  expect(await screen.findByText("Could not load destination trust.")).toBeTruthy();
  failing = false;
  for (const button of screen.getAllByRole("button", { name: "Retry" })) fireEvent.click(button);
  expect(await screen.findByText("Nothing is waiting for an answer.")).toBeTruthy();
  expect(await screen.findByText(/No key grants yet/)).toBeTruthy();
  expect(await screen.findByText(/No pinned destinations yet/)).toBeTruthy();
});
