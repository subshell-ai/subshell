import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar";
import * as quickAdd from "@/components/quick-add";
import { resetDesktopShellForTests } from "@/lib/desktop";
import { setFetchRouter } from "@/test-setup";

const SERVER_UA = "Mozilla/5.0 SubshellDesktop/0.5.0 (macos; p=1; b=0.5.0)";
const nav = globalThis.navigator as unknown as Record<string, unknown>;
let previousUserAgent: PropertyDescriptor | undefined;

/** Point the UA at the server shell for the next render, then hand it back. */
function setUA(userAgent: string) {
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  resetDesktopShellForTests();
}
function restoreUA() {
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  else delete nav.userAgent;
  previousUserAgent = undefined;
  resetDesktopShellForTests();
}

async function renderRail(path: string, admin = false, variant: "web" | "desktop" = "web") {
  setFetchRouter(async (input) => {
    const url = String(input);
    const body = url.includes("/api/settings/public")
      ? { viewerIsAdmin: admin }
      : url.includes("get-session")
        ? { user: { name: "Test", email: "test@example.test" } }
        : url.includes("/api/subshells/subagents")
          ? // The batch snapshot the rail rows share; empty means "no children".
            {}
          : [];
    return Response.json(body);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <quickAdd.QuickAddProvider>
        <AppSidebar variant={variant} />
      </quickAdd.QuickAddProvider>
    ),
  });
  const paths = [
    "/",
    "/workspaces",
    "/workspaces/$id",
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

/**
 * Records `defaultPrevented` for every click that bubbles past the root.
 *
 * The document listener runs after React's root-delegated handler and after the
 * Link's own logic, so what it sees is the sidebar's actual verdict; it then
 * cancels the navigation itself, because a passed-through happy-dom link click
 * would load a document the test router never made.
 */
function defaultPreventedTracker() {
  const seen: boolean[] = [];
  const watch = (event: MouseEvent) => {
    seen.push(event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener("click", watch);
  return { seen, stop: () => document.removeEventListener("click", watch) };
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
  localStorage.removeItem("subshell.sidebarCollapsed");
  restoreUA();
});

describe("the panel and its bottom section bar", () => {
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
      fireEvent.click(screen.getByRole("link", { name: "Settings" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/nodes"));
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

  it("test_section_bar_named_links_no_logo: the bar exposes the two section links, the mobile-dialog cell and the account card cell, plus Open in browser in a shell", async () => {
    await renderRail("/nodes");
    const bar = screen.getByRole("navigation", { name: "Main sections" });
    expect(
      within(bar)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Workspaces", "Settings"]);
    // The Workspaces cell wears the mark the old collapsed rail used; the
    // link's aria-label names it, so the image itself stays decorative.
    const mark = within(bar).getByRole("link", { name: "Workspaces" }).querySelector('img[src="/icons/mark-40.png"]');
    expect(mark?.getAttribute("alt")).toBe("");
    expect(within(bar).getByRole("button", { name: "Subshell for Mobile" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Account: Test" })).toBeTruthy();
    expect(within(bar).queryByRole("link", { name: "Subshell" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Open in browser" })).toBeNull();
    cleanup();
    setUA(SERVER_UA);
    await renderRail("/nodes");
    const desktopBar = screen.getByRole("navigation", { name: "Main sections" });
    expect(within(desktopBar).getByRole("button", { name: "Open in browser" })).toBeTruthy();
    expect(within(desktopBar).getAllByRole("link")).toHaveLength(2);
  });

  it("test_mobile_cell_opens_dialog: the bar's mobile cell opens the install dialog instead of navigating", async () => {
    const router = await renderRail("/nodes");
    fireEvent.click(screen.getByRole("button", { name: "Subshell for Mobile" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Subshell for Mobile")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/nodes");
    // Drain the dialog's public-settings refetch so its notify cannot land
    // outside an acting scope after the test returns.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("test_account_cell_opens_card: the bar's account cell opens the profile card instead of navigating", async () => {
    const router = await renderRail("/nodes");
    const cell = screen.getByRole("button", { name: "Account: Test" });
    // Base UI opens on pointerdown, which happy-dom cannot emulate; ArrowDown
    // is the keyboard equivalent.
    fireEvent.keyDown(cell, { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Account settings" })).toBeTruthy();
    expect(await screen.findByText("test@example.test")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/nodes");
  });

  it("test_panel_width_retired_rail: the panel sheds the retired rail's width and the desktop bar's fifth button still fits", async () => {
    // Browser: four size-11 buttons (4*44 + 3*4 gap + 16 padding = 204px) inside w-58 (232px).
    await renderRail("/nodes");
    expect(document.querySelector("aside")?.classList.contains("w-58")).toBe(true);
    cleanup();
    // Server desktop shell: the bar gains "Open in browser", and five size-11
    // buttons (5*44 + 4*4 + 16 = 252px) need w-64 (256px); w-62 would clip them.
    setUA(SERVER_UA);
    await renderRail("/nodes", false, "desktop");
    const aside = document.querySelector("aside");
    expect(aside?.classList.contains("w-64")).toBe(true);
    const bar = screen.getByRole("navigation", { name: "Main sections" });
    // Four cells ride the bar (Workspaces, mobile, Settings, Account) and the
    // shell adds a fifth; only two of them are links now.
    expect(within(bar).getAllByRole("link")).toHaveLength(2);
    expect(within(bar).getByRole("button", { name: "Open in browser" })).toBeTruthy();
  });

  it("test_no_collapse_pref_or_state: clicking the active section never collapses the panel or records a preference", async () => {
    const router = await renderRail("/nodes");
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(localStorage.getItem("subshell.sidebarCollapsed")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/nodes");
  });

  it("test_active_click_goes_to_remembered_page: inactive and active clicks land on the remembered page, except Workspaces inside a workspace", async () => {
    const router = await renderRail("/presets");
    fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces"));
    await screen.findByRole("region", { name: "Subshells" });
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/presets"));
    await act(async () => {
      router.history.back();
    });
    await screen.findByRole("region", { name: "Subshells" });
    await act(async () => {
      await router.navigate({ to: "/workspaces/$id", params: { id: "w1" } });
    });
    const tracker = defaultPreventedTracker();
    try {
      fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));
    } finally {
      tracker.stop();
    }
    expect(tracker.seen).toEqual([true]);
    expect(router.state.location.pathname).toBe("/workspaces/w1");
  });

  it("test_active_section_marks_current: the section link matching the route carries aria-current page", async () => {
    const router = await renderRail("/nodes");
    const bar = screen.getByRole("navigation", { name: "Main sections" });
    expect(within(bar).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    expect(within(bar).getByRole("link", { name: "Workspaces" }).getAttribute("aria-current")).toBeNull();
    await act(async () => {
      await router.navigate({ to: "/account" });
    });
    // Account is the profile card's trigger, not a route: even while
    // /account is on screen its cell carries no aria-current.
    expect(within(bar).getByRole("button", { name: "Account: Test" }).getAttribute("aria-current")).toBeNull();
    await act(async () => {
      await router.navigate({ to: "/mobile" as never });
    });
    expect(within(bar).getByRole("button", { name: "Subshell for Mobile" }).getAttribute("aria-current")).toBeNull();
  });

  it("test_modified_click_passes_through: modifier and middle clicks are never preventDefaulted, plain Workspaces clicks inside a workspace are", async () => {
    const router = await renderRail("/workspaces/w1");
    const tracker = defaultPreventedTracker();
    try {
      fireEvent.click(screen.getByRole("link", { name: "Workspaces" }), { metaKey: true });
      fireEvent.click(screen.getByRole("link", { name: "Workspaces" }), { button: 1 });
      expect(tracker.seen).toEqual([false, false]);
      fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));
      expect(tracker.seen).toEqual([false, false, true]);
    } finally {
      tracker.stop();
    }
    expect(router.state.location.pathname).toBe("/workspaces/w1");
  });

  it("makes mobile platform choices navigation links instead of opening a modal", async () => {
    await renderRail("/mobile?platform=android");
    expect(screen.getByRole("link", { name: "Android" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "iPhone & iPad" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
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
