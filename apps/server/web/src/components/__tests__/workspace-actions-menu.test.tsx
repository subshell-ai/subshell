import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { setConfirmHandler } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { setFetchRouter } from "@/test-setup";
import type { WorkspaceRow } from "@/types/workspace";

const workspace: WorkspaceRow = {
  id: "w-1",
  name: "demo ws",
  layout: null,
  subshellCount: 2,
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

  it("right-click offers the curated set — new tab, QR, rename, delete; not the redundant 'Open'", async () => {
    await renderRow();
    expect(screen.getByText("ws row")).toBeDefined();
    fireEvent.contextMenu(screen.getByText("ws row"));
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(5));
    expect(screen.getByRole("menuitem", { name: "Add subshell" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Open in new tab" })).toBeDefined();
    // "Open this one somewhere else", the somewhere else being a phone —
    // sidebar-flagged for the same reason "Open in new tab" is (2026-09-19).
    expect(screen.getByRole("menuitem", { name: "QR code…" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Rename…" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Delete workspace" })).toBeDefined();
    // The row itself is the Open link — offering "Open" again would be noise.
    expect(screen.queryByRole("menuitem", { name: "Open" })).toBeNull();
  });

  it("the ⋯ menu omits Open and keeps the remaining actions", async () => {
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
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(5));
    expect(screen.queryByRole("menuitem", { name: "Open" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "QR code…" })).toBeDefined();
  });
});

describe("renaming from the menu (spec 2026-10-17)", () => {
  afterEach(() => {
    cleanup();
    setFetchRouter(null);
  });

  it("opens prefilled, PUTs the new name, and closes", async () => {
    const puts: string[] = [];
    setFetchRouter(async (input: RequestInfo | URL) => {
      const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.includes("/api/workspaces/w-1")) {
        puts.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    await renderRow();
    fireEvent.contextMenu(screen.getByText("ws row"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const field = await screen.findByRole("textbox", { name: "Workspace name" });
    // Prefilled with the current name: editing a name means changing a few
    // characters, not retyping the row.
    expect((field as HTMLInputElement).value).toBe("demo ws");
    fireEvent.change(field, { target: { value: "Deck 2026-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Workspace name" }) === null).toBe(true));
  });

  it("disables Save on an empty name", async () => {
    setFetchRouter(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    await renderRow();
    fireEvent.contextMenu(screen.getByText("ws row"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const field = await screen.findByRole("textbox", { name: "Workspace name" });
    fireEvent.change(field, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-description")).toBe(
      "Enter a workspace name.",
    );
  });

  it("reports a failed sidebar deletion instead of silently leaving the workspace", async () => {
    const previous = setConfirmHandler(async () => true);
    const notice = spyOn(toast, "error").mockImplementation(() => "notice");
    setFetchRouter(async () => new Response("{}", { status: 500 }));
    try {
      await renderRow();
      fireEvent.contextMenu(screen.getByText("ws row"));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Delete workspace" }));
      await waitFor(() => expect(notice).toHaveBeenCalledTimes(1));
    } finally {
      setConfirmHandler(previous);
      notice.mockRestore();
    }
  });
});
