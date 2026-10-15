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
import { SshPresetLibrary } from "@/components/presets/ssh-preset-library";

const SshSettingsPage = () => <SshPresetLibrary onCreate={() => {}} creating={false} onCreatedClose={() => {}} />;

const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});

test("loading and failed reads never claim an empty SSH preset library; retry recovers", async () => {
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
    return new Response(JSON.stringify([]));
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
  expect(await screen.findByText("Loading SSH presets…")).toBeTruthy();
  expect(screen.queryByText("No SSH presets yet")).toBeNull();
  expect(screen.queryByText("No recent destinations yet.")).toBeNull();
  respond();
  expect(await screen.findByText("Could not load SSH presets.")).toBeTruthy();
  expect(screen.queryByText("No SSH presets yet")).toBeNull();
  failing = false;
  for (const button of screen.getAllByRole("button", { name: "Retry" })) fireEvent.click(button);
  expect(await screen.findByText("No SSH presets yet")).toBeTruthy();
});
