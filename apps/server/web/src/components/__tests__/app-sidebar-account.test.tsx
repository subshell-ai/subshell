import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import * as quickAdd from "@/components/quick-add";
import * as auth from "@/lib/auth";
import { setFetchRouter } from "@/test-setup";

/** Account context retains sign out, version details and admin-only update notices. */

function stubFetch(opts: { admin: boolean; updateTo?: string }) {
  const calls: string[] = [];
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const path = new URL(url, "http://localhost").pathname;
    calls.push(path);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/api/settings/public") {
      return json({ viewerIsAdmin: opts.admin, instanceName: "Test plane", serverVersion: "0.11.1" });
    }
    if (path === "/api/admin/updates") {
      const to = opts.updateTo ?? null;
      return json({
        server: {
          current: "0.11.1",
          updateAvailable: to !== null,
          latest: to === null ? null : { version: to, tag: `cli-server-v${to}` },
        },
      });
    }
    if (url.includes("get-session")) {
      return json({ user: { id: "u1", name: "Admin", email: "admin@test" } });
    }
    return json([]);
  });
  return calls;
}

function renderRail(initialPath: string, footerEnd?: () => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => <AppSidebar footerEnd={footerEnd} />,
  });
  const paths = [
    "/",
    "/workspaces",
    "/nodes",
    "/presets",
    "/prompts",
    "/preferences",
    "/account",
    "/settings",
    "/settings/users",
    "/settings/auth",
    "/settings/api-keys",
    "/settings/plugins",
    "/settings/service",
    "/settings/networking",
    "/settings/updates",
    "/settings/backups",
    "/settings/status",
    "/settings/logs",
  ];
  const children = paths.map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const signOutButton = () => screen.getByRole("button", { name: "Sign out" });

let restoreQuickAdd: () => void;
beforeEach(() => {
  const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
    openLaunch: () => {},
    openSshLaunch: () => {},
    openNewWorkspace: () => {},
  });
  restoreQuickAdd = () => spy.mockRestore();
});

afterEach(() => {
  cleanup();
  // Keep the mock alive until pending renders can no longer reach the sidebar.
  restoreQuickAdd();
  localStorage.removeItem("subshell.sidebarCollapsed");
  setFetchRouter(null);
});

describe("the contextual account sidebar", () => {
  const withRail = async (
    opts: { admin: boolean; updateTo?: string; footer?: boolean },
    body: () => Promise<void> | void,
  ) => {
    const calls = stubFetch(opts);
    const router = renderRail("/account", opts.footer ? () => <span data-testid="plane-row" /> : undefined);
    await waitFor(() => expect(signOutButton()).toBeTruthy());
    await body();
    return { calls, router };
  };

  it("integrates account actions into its context and leaves the browser rail footerless", async () => {
    await withRail({ admin: false }, async () => {
      expect(signOutButton()).toBeTruthy();
      expect(screen.getAllByRole("link", { name: "Preferences" }).length).toBe(1);
      expect(screen.getAllByRole("link", { name: "Profile" }).length).toBe(1);
      expect(screen.getByRole("link", { name: "Feedback" }).getAttribute("target")).toBe("_blank");
      expect(screen.queryAllByRole("button", { name: /Account:/ }).length).toBe(0);
      // The bordered footer div was a direct child of the aside with
      // `border-t`; nothing supplies footerEnd on the web, so none exists.
      expect(document.querySelectorAll("aside > div.border-t").length).toBe(0);
    });
  });

  it("signs out only after confirmation, and Cancel leaves the session alone", async () => {
    const signOut = spyOn(auth, "signOutAndRedirect").mockResolvedValue(undefined);
    let answer: ((confirmed: boolean) => void) | undefined;
    const previous = setConfirmHandler(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    try {
      await withRail({ admin: false }, async () => {
        fireEvent.click(signOutButton());
        expect(signOut).not.toHaveBeenCalled();
        answer?.(false);
        await Promise.resolve();
        expect(signOut).not.toHaveBeenCalled();
        fireEvent.click(signOutButton());
        expect(signOut).not.toHaveBeenCalled();
        answer?.(true);
        await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
      });
    } finally {
      setConfirmHandler(previous);
      signOut.mockRestore();
    }
  });

  it("gives a member the version line and never fires the admin updates read", async () => {
    const run = await withRail({ admin: false }, async () => {
      // Version and instance name are separate detail lines (split 2026-10-09
      // so a long hostname cannot truncate the version away).
      expect(await screen.findByText("Subshell Server 0.11.1")).toBeTruthy();
      expect(screen.getByText("Test plane")).toBeTruthy();
      expect(screen.queryAllByRole("link", { name: /Update available/ }).length).toBe(0);
    });
    expect(run?.calls).not.toContain("/api/admin/updates");
    expect(screen.queryAllByRole("img", { name: "Update available" }).length).toBe(0);
  });

  it("gives an admin with news the rail dot and a row that walks to /settings/updates", async () => {
    const run = await withRail({ admin: true, updateTo: "0.12.0" }, async () => {
      await waitFor(() => expect(screen.queryAllByRole("img", { name: "Update available" }).length).toBeGreaterThan(0));
      fireEvent.click(await screen.findByRole("link", { name: "Update available: v0.12.0" }));
    });
    await waitFor(() => expect(run?.router.state.location.pathname).toBe("/settings/updates"));
  });

  it("gives an admin with nothing published neither dot nor row, still no door", async () => {
    const run = await withRail({ admin: true }, async () => {
      // The retired footer was a door even with no news; §B moved that door
      // to the Server Settings group's Updates page, so the card stays quiet.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryAllByRole("img", { name: "Update available" }).length).toBe(0);
      await screen.findByRole("button", { name: "Sign out" });
      expect(screen.queryAllByRole("link", { name: /Update available/ }).length).toBe(0);
    });
    expect(run?.calls).toContain("/api/admin/updates");
  });

  it("keeps the desktop shell's footer rows", async () => {
    await withRail({ admin: true, footer: true }, async () => {
      expect(screen.getByTestId("plane-row")).toBeTruthy();
      // The card moved up; it is not stacked back into the footer. A missing
      // footer (`?.`) lands on -1, which fails the same way.
      const footer = document.querySelector("aside > div.border-t");
      expect(footer?.querySelectorAll("button").length ?? -1).toBe(0);
    });
  });

  it("keeps Account reachable from the collapsed mini rail", async () => {
    localStorage.setItem("subshell.sidebarCollapsed", "1");
    stubFetch({ admin: false });
    renderRail("/account");
    const link = await screen.findByRole("link", { name: "Account" });
    expect(screen.queryAllByRole("button", { name: "Sign out" }).length).toBe(0);
    fireEvent.click(link);
    await waitFor(() => expect(signOutButton()).toBeTruthy());
    expect(localStorage.getItem("subshell.sidebarCollapsed")).toBe("0");
  });
});
