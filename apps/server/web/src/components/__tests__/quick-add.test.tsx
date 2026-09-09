import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QuickAddProvider, useQuickAdd } from "@/components/quick-add";

/**
 * The quick-add dialogs must live at the shell root, not inside the sidebar:
 * on phones the sidebar mounts inside the nav drawer, and a dialog opened
 * there is a SECOND stacked modal — the touch scroll-locks fight and fling
 * the launch dialog's scroller (2026-09-04 e2e repro). The provider keeps
 * exactly one copy mounted outside any drawer; the rail only triggers.
 */
afterEach(cleanup);

/** Let the form's initial queries settle inside act() before the test ends. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

function Trigger() {
  const quickAdd = useQuickAdd();
  return (
    <div>
      <button type="button" onClick={quickAdd.openLaunch}>
        rail + (subshell)
      </button>
      <button type="button" onClick={quickAdd.openNewWorkspace}>
        rail + (workspace)
      </button>
    </div>
  );
}

async function renderProvider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <QuickAddProvider>
        <Trigger />
      </QuickAddProvider>
    ),
  });
  const subshellRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, subshellRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
}

describe("QuickAddProvider", () => {
  it("opens the launch dialog from the root, not the sidebar subtree", async () => {
    await renderProvider();
    await act(async () => {
      screen.getByText("rail + (subshell)").click();
    });
    expect(await screen.findByText("Launch an agent harness in a working directory.")).toBeDefined();
    // The workspace dialog stays closed — the two triggers are independent.
    expect(screen.queryByText("Start it with subshells already tiled in, or empty.")).toBeNull();
    await flush();
  });

  it("opens the new-workspace dialog from its trigger", async () => {
    await renderProvider();
    await act(async () => {
      screen.getByText("rail + (workspace)").click();
    });
    expect(await screen.findByText("Start it with subshells already tiled in, or empty.")).toBeDefined();
    expect(screen.queryByText("Launch an agent harness in a working directory.")).toBeNull();
    await flush();
  });

  it("throws when a trigger is mounted without the provider", () => {
    // The old sidebar-local state must not come back: a consumer outside the
    // provider is a wiring bug, and a silent no-op button is how it hid.
    const realError = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Trigger />)).toThrow(/QuickAddProvider/);
    } finally {
      console.error = realError;
    }
  });
});
