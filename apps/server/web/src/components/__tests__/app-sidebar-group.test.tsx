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
import { AppSidebar } from "@/components/app-sidebar";
import * as quickAdd from "@/components/quick-add";
import { setFetchRouter } from "@/test-setup";

/**
 * The group's open/close WIRING, as opposed to the rule it applies.
 *
 * `groupOpen()` is a pure `override ?? childActive` and cannot meaningfully
 * regress; the bug users actually hit — "I'm not able to collapse things",
 * 2026-09-12 — lived entirely in what this file exercises: that a press flips
 * the state the header is CURRENTLY SHOWING rather than a stored flag, and
 * that a press expires when the route changes. Both are invisible to a test
 * of the pure function, and both are one careless edit away from returning.
 */

/**
 * Answers every query the rail mounts, so nothing reaches the network.
 *
 * Through `setFetchRouter` rather than by swapping `globalThis.fetch`: the
 * better-auth client behind `useCurrentUser` binds fetch at MODULE
 * EVALUATION, so a later swap is invisible to it and the session request goes
 * to the real network (ECONNREFUSED noise, and a test that depends on nothing
 * listening on port 80). The preload's delegator is what that binding
 * captured; see `src/test-setup.ts`.
 */
function stubFetch(isAdmin: boolean): () => void {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = url.includes("/api/settings/public")
      ? { viewerIsAdmin: isAdmin, instanceName: "Test plane" }
      : url.includes("get-session")
        ? { user: { id: "u1", name: "Admin", email: "admin@test" } }
        : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return () => setFetchRouter(null);
}

/**
 * The group's child container, by the id its header points `aria-controls`
 * at — which also asserts that reference resolves.
 *
 * Openness is read from `aria-expanded` and this element's `hidden` CLASS,
 * never from whether the links are queryable: the children stay mounted (so
 * `aria-controls` has something to name) and are hidden by Tailwind's
 * `display:none`, but no stylesheet is loaded here, so a role query finds
 * them in both states.
 */
function childList(): HTMLElement {
  const id = header().getAttribute("aria-controls");
  const el = id ? document.getElementById(id) : null;
  if (!el) throw new Error("the group header's aria-controls names no element");
  return el;
}

function renderRail(initialPath: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <AppSidebar /> });
  // Every path the rail links to must exist, or clicking a child throws.
  const paths = ["/", "/workspaces", "/nodes", "/presets", "/settings"];
  const children = paths.map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  for (const path of [
    "/settings/users",
    "/settings/api-keys",
    "/settings/plugins",
    "/settings/service",
    "/settings/updates",
    "/settings/status",
    "/settings/logs",
  ]) {
    children.push(createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const header = () => screen.getByRole("button", { name: /Server Settings/ });
const expanded = () => header().getAttribute("aria-expanded");

afterEach(cleanup);

describe("the Server Settings group's open/close wiring", () => {
  // The rail calls useQuickAdd(), which throws outside its provider; the real
  // provider would mount two dialogs and their data, none of it under test.
  const withRail = async (path: string, body: () => Promise<void> | void) => {
    const restoreFetch = stubFetch(true);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
      openLaunch: () => {},
      openNewWorkspace: () => {},
    });
    try {
      renderRail(path);
      // The group is admin-gated, so it appears only once the settings query
      // resolves — "unknown ≠ open" means it is genuinely absent until then.
      await waitFor(() => expect(header()).toBeTruthy());
      await body();
    } finally {
      spy.mockRestore();
      restoreFetch();
    }
  };

  it("is shut on a page outside the group, and a press opens it", async () => {
    await withRail("/", async () => {
      expect(expanded()).toBe("false");
      expect(childList().className).toContain("hidden");
      fireEvent.click(header());
      await waitFor(() => expect(expanded()).toBe("true"));
      expect(childList().className).not.toContain("hidden");
      expect(screen.getByRole("link", { name: "Logs" })).toBeTruthy();
    });
  });

  it("is open on a page INSIDE the group, and a press SHUTS it", async () => {
    // The reported bug: the old rule forced this open, so the press did
    // nothing on exactly the pages a person presses it from.
    await withRail("/settings/logs", async () => {
      expect(expanded()).toBe("true");
      fireEvent.click(header());
      await waitFor(() => expect(expanded()).toBe("false"));
      fireEvent.click(header());
      await waitFor(() => expect(expanded()).toBe("true"));
    });
  });

  it("still names the current page while shut over it", async () => {
    // What the forced-open rule was protecting, and why shutting it is safe:
    // the header keeps the lit class, so the rail can still say where you are.
    await withRail("/settings/logs", async () => {
      fireEvent.click(header());
      await waitFor(() => expect(expanded()).toBe("false"));
      expect(header().className).toContain("text-accent-foreground");
    });
  });

  it("expires the press on navigation, so leaving the group shuts it", async () => {
    await withRail("/settings/logs", async () => {
      // Press to OPEN-override while already open — a no-op visually, and the
      // press that a stale record would carry to the next route.
      fireEvent.click(header());
      await waitFor(() => expect(expanded()).toBe("false"));
      fireEvent.click(header());
      await waitFor(() => expect(expanded()).toBe("true"));
      fireEvent.click(screen.getByRole("link", { name: "Nodes" }));
      await waitFor(() => expect(expanded()).toBe("false"));
    });
  });

  it("opens on navigation INTO the group, with no press at all", async () => {
    await withRail("/", async () => {
      fireEvent.click(header());
      await waitFor(() => expect(expanded()).toBe("true"));
      fireEvent.click(screen.getByRole("link", { name: "General" }));
      await waitFor(() => expect(expanded()).toBe("true"));
      // Leaving again shuts it, proving the open above came from the route
      // rather than from the press that survived.
      fireEvent.click(screen.getByRole("link", { name: "Presets" }));
      await waitFor(() => expect(expanded()).toBe("false"));
    });
  });

  it("hides the whole group from a non-admin", async () => {
    const restoreFetch = stubFetch(false);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
      openLaunch: () => {},
      openNewWorkspace: () => {},
    });
    try {
      renderRail("/");
      await waitFor(() => expect(screen.getByRole("link", { name: "Nodes" })).toBeTruthy());
      expect(screen.queryByRole("button", { name: /Server Settings/ })).toBeNull();
      // Users moved INSIDE the group, so it goes too — the reversal that
      // e2e's member spec also pins.
      expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
    } finally {
      spy.mockRestore();
      restoreFetch();
    }
  });
});
