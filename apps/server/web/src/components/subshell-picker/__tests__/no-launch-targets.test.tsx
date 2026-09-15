import { describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NoLaunchTargets } from "@/components/subshell-picker/no-launch-targets";
import type { Node } from "@/types/node";

/**
 * Both ways out of "nowhere to launch" have to CLOSE what contains them.
 *
 * Every caller of the launch form is a dialog `QuickAddProvider` mounts above
 * the route (`routes/__root.tsx`), so a button that only navigates changes the
 * page UNDERNEATH a modal that stays up — still showing this same empty state,
 * over the very page that fixes it. "Enable on Server" did exactly that while
 * "Add a node" did not, which made the switch-it-back-on route look broken to
 * the one person who could take it.
 */

const LOCAL_OFF: Node = {
  id: "local",
  name: "Server",
  kind: "local",
  status: "online",
  canManage: true,
  canLaunch: false,
} as Node;

/** Render the empty state under a router that owns both destinations. */
async function mount(local: Node | null): Promise<{ onNavigate: ReturnType<typeof mock>; restore: () => void }> {
  const onNavigate = mock(() => {});
  // `canAddNode` reads public settings; an unanswered read counts as allowed,
  // so this only keeps the component off the real network.
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({})))) as unknown as typeof fetch;
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NoLaunchTargets local={local} onNavigate={onNavigate} />
      </QueryClientProvider>
    ),
  });
  const nodesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/nodes" });
  const nodeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/nodes/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([nodesRoute, nodeRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(screen.getByText("No machine can run a subshell")).toBeDefined());
  return { onNavigate, restore: () => (globalThis.fetch = original) };
}

describe("NoLaunchTargets", () => {
  it("closes the dialog before going to the host's node page", async () => {
    const { onNavigate, restore } = await mount(LOCAL_OFF);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Enable on Server" }));
      expect(onNavigate).toHaveBeenCalled();
    } finally {
      cleanup();
      restore();
    }
  });

  it("closes the dialog before going to the Nodes page", async () => {
    const { onNavigate, restore } = await mount(LOCAL_OFF);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Add a node" }));
      expect(onNavigate).toHaveBeenCalled();
    } finally {
      cleanup();
      restore();
    }
  });
});
