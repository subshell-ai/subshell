import { afterEach, describe, expect, it, spyOn } from "bun:test";
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
import { setFetchRouter } from "@/test-setup";

/**
 * The account card where the footer used to be (spec 2026-10-07 §B/§C).
 * What these pin: the card sits in the header and the browser rail carries no
 * footer at all; the version row's audience split survives the move (member
 * never fetches /api/admin/updates, no dot; admin with news gets dot + row +
 * door); desktop shells keep their footer rows. The trigger's accessible name
 * keeps its /Account:/ prefix (the update notice is appended after it when
 * the dot is lit) - the e2e specs sign out through it.
 *
 * Negative DOM asserts in this file use the length-based forms
 * (`querySelectorAll(...).length` / `queryAllByRole(...).length`) because they
 * fail on presence by construction. The element-`toBeNull()` forms are sound
 * generally; a rewrite back to them here is not wanted.
 */

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

const accountTrigger = () => screen.getByRole("button", { name: /Account: Admin/ });

afterEach(() => {
  cleanup();
  localStorage.removeItem("subshell.sidebarCollapsed");
  setFetchRouter(null);
});

describe("the header account card", () => {
  const withRail = async (
    opts: { admin: boolean; updateTo?: string; footer?: boolean },
    body: () => Promise<void> | void,
  ) => {
    const calls = stubFetch(opts);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
      openLaunch: () => {},
      openNewWorkspace: () => {},
    });
    try {
      const router = renderRail("/", opts.footer ? () => <span data-testid="plane-row" /> : undefined);
      await waitFor(() => expect(accountTrigger()).toBeTruthy());
      await body();
      return { calls, router };
    } finally {
      spy.mockRestore();
    }
  };

  it("replaces the footer card and leaves the browser rail footerless", async () => {
    await withRail({ admin: false }, async () => {
      expect(accountTrigger()).toBeTruthy();
      // The bordered footer div was a direct child of the aside with
      // `border-t`; nothing supplies footerEnd on the web, so none exists.
      expect(document.querySelectorAll("aside > div.border-t").length).toBe(0);
      // Sign out still reaches anyone, everywhere.
      fireEvent.click(accountTrigger());
      fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    });
  });

  it("gives a member the version line and never fires the admin updates read", async () => {
    const run = await withRail({ admin: false }, async () => {
      fireEvent.click(accountTrigger());
      // Version and instance name are separate detail lines (split 2026-10-09
      // so a long hostname cannot truncate the version away).
      expect(await screen.findByText("Subshell Server 0.11.1")).toBeTruthy();
      expect(screen.getByText("Test plane")).toBeTruthy();
      expect(screen.queryAllByRole("menuitem", { name: /Update available/ }).length).toBe(0);
    });
    expect(run?.calls).not.toContain("/api/admin/updates");
    expect(accountTrigger().querySelectorAll(".bg-warning").length).toBe(0);
  });

  it("gives an admin with news the avatar dot and a row that walks to /settings/updates", async () => {
    const run = await withRail({ admin: true, updateTo: "0.12.0" }, async () => {
      await waitFor(() => expect(accountTrigger().querySelectorAll(".bg-warning").length).toBeGreaterThan(0));
      fireEvent.click(accountTrigger());
      fireEvent.click(await screen.findByRole("menuitem", { name: "Update available: v0.12.0" }));
    });
    await waitFor(() => expect(run?.router.state.location.pathname).toBe("/settings/updates"));
  });

  it("gives an admin with nothing published neither dot nor row, still no door", async () => {
    const run = await withRail({ admin: true }, async () => {
      // The retired footer was a door even with no news; §B moved that door
      // to the Server Settings group's Updates page, so the card stays quiet.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(accountTrigger().querySelectorAll(".bg-warning").length).toBe(0);
      fireEvent.click(accountTrigger());
      await screen.findByRole("menuitem", { name: "Sign out" });
      expect(screen.queryAllByRole("menuitem", { name: /Update available/ }).length).toBe(0);
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

  it("collapses to the avatar alone", async () => {
    localStorage.setItem("subshell.sidebarCollapsed", "1");
    await withRail({ admin: false }, async () => {
      expect(accountTrigger()).toBeTruthy();
      // No display-name text on the face of the collapsed rail.
      expect(screen.queryAllByText("Admin").length).toBe(0);
    });
  });
});
