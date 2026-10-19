import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar";
import * as quickAdd from "@/components/quick-add";
import { setFetchRouter } from "@/test-setup";

async function renderRail(path: string, admin = false) {
  setFetchRouter(async (input) => {
    const url = String(input);
    const body = url.includes("/api/settings/public")
      ? { viewerIsAdmin: admin }
      : url.includes("get-session")
        ? { user: { name: "Test", email: "test@example.test" } }
        : [];
    return Response.json(body);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <quickAdd.QuickAddProvider>
        <AppSidebar />
      </quickAdd.QuickAddProvider>
    ),
  });
  const paths = [
    "/",
    "/workspaces",
    "/subshells",
    "/nodes",
    "/nodes/local",
    "/presets",
    "/prompts",
    "/settings",
    "/settings/logs",
    "/mobile",
    "/account",
    "/preferences",
  ];
  const router = createRouter({
    routeTree: root.addChildren(
      paths.map((path) => createRoute({ getParentRoute: () => root, path, component: () => null })),
    ),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("navigation", { name: "Main sections" });
  return router;
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
  localStorage.removeItem("subshell.sidebarCollapsed");
});

describe("contextual two-rail navigation", () => {
  it("opens settings for a direct node detail link and gates admin pages", async () => {
    await renderRail("/nodes/local");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Nodes" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Prompts" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Logs" })).toBeNull();
  });
  it("updates the active section link immediately when its subsection changes", async () => {
    const router = await renderRail("/nodes");
    await act(async () => {
      await router.navigate({ to: "/presets" });
    });
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/presets");
  });

  it("opens the workspace page even when the remembered landing route would redirect", async () => {
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
      openLaunch() {},
      openSshLaunch() {},
      openNewWorkspace() {},
    });
    try {
      const router = await renderRail("/");
      await act(async () => {
        await router.navigate({ to: "/subshells" });
      });
      fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces"));
      expect(screen.getByRole("combobox", { name: "Switch workspace" })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps admin pages together inside Settings", async () => {
    await renderRail("/settings/logs", true);
    await screen.findByRole("link", { name: "Logs" });
    expect(screen.getByRole("heading", { name: "Server Settings" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Logs" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("combobox", { name: "Switch workspace" })).toBeNull();
  });
  it("changes subsections with the mini rail and restores the last settings page", async () => {
    const router = await renderRail("/presets");
    fireEvent.click(screen.getByRole("link", { name: "Subshells" }));
    await screen.findByRole("region", { name: "Subshells" });
    expect(screen.queryByRole("link", { name: "Nodes" })).toBeNull();
    expect(router.state.location.pathname).toBe("/subshells");
    expect(screen.getByRole("textbox", { name: "Filter sidebar subshells" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/presets"));
    await act(async () => {
      router.history.back();
    });
    await screen.findByRole("region", { name: "Subshells" });
  });
  it("makes mobile platform choices navigation links instead of opening a modal", async () => {
    await renderRail("/mobile?platform=android");
    expect(screen.getByRole("link", { name: "Android" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "iPhone & iPad" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("can collapse and reopen the contextual sidebar", async () => {
    await renderRail("/nodes");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("navigation", { name: "Settings pages" })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeTruthy();
  });
  it("shows only the chosen workspace and recovers a failed workspace read", async () => {
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
      openLaunch() {},
      openSshLaunch() {},
      openNewWorkspace() {},
    });
    try {
      const router = await renderRail("/nodes");
      let fail = true;
      setFetchRouter(async (input) => {
        if (String(input).includes("/api/workspaces"))
          return fail
            ? Response.json({ error: "Unavailable" }, { status: 500 })
            : Response.json([
                {
                  id: "w1",
                  name: "Current work",
                  updatedAt: "2026-10-18",
                  subshellCount: 1,
                  panes: [{ id: "p1", subshellId: "s1", subshellName: "Current pane", workingDir: "/tmp/current" }],
                },
                {
                  id: "w2",
                  name: "Other work",
                  updatedAt: "2026-10-17",
                  subshellCount: 1,
                  panes: [{ id: "p2", subshellId: "s2", subshellName: "Other pane", workingDir: "/tmp/other" }],
                },
              ]);
        return Response.json([]);
      });
      await act(async () => {
        await router.navigate({ to: "/" });
      });
      await screen.findByText("Couldn’t load workspaces.");
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("Current pane");
      expect(screen.queryByText("Other pane")).toBeNull();
      expect(screen.getByRole("combobox", { name: "Switch workspace" })).toBeTruthy();
    } finally {
      cleanup();
      spy.mockRestore();
    }
  });
});
