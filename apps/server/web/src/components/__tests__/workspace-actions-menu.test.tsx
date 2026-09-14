import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import type { WorkspaceRow } from "@/types/workspace";

const workspace: WorkspaceRow = {
  id: "w-1",
  name: "demo ws",
  layout: null,
  subshellCount: 2,
  draft: false,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

/** Children mode renders inside a throwaway router + query client (the
 *  component navigates and invalidates — the same harness the subshell
 *  actions-menu test uses). */
async function renderRow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <WorkspaceActionsMenu workspace={workspace}>
        <a href="/workspaces/w-1">ws row</a>
      </WorkspaceActionsMenu>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("WorkspaceActionsMenu — context mode (spec 2026-09-03)", () => {
  afterEach(cleanup);

  it("right-click offers the curated pair — new tab + delete, not the redundant 'Open'", async () => {
    await renderRow();
    expect(screen.getByText("ws row")).toBeDefined();
    fireEvent.contextMenu(screen.getByText("ws row"));
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(2));
    expect(screen.getByRole("menuitem", { name: "Open in new tab" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Delete workspace" })).toBeDefined();
    // The row itself is the Open link — offering "Open" again would be noise.
    expect(screen.queryByRole("menuitem", { name: "Open" })).toBeNull();
  });

  it("the ⋯ page menu keeps all three items", async () => {
    // Button mode ignores the sidebar flags — asserted through the same
    // component the page renders (no children).
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <WorkspaceActionsMenu workspace={workspace} />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultPreload: false,
    });
    await router.load();
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for demo ws" }), { key: "ArrowDown" });
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(3));
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeDefined();
  });
});
