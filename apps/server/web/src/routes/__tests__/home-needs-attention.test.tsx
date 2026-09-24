import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import * as quickAdd from "@/components/quick-add";
import { Route } from "@/routes/index";
import { setFetchRouter } from "@/test-setup";
import type { SubshellView } from "@/types/subshell";

/**
 * The home page's Needs Attention section (spec 2026-09-24): the same
 * `needsAttention` rule the rail uses, rendered through the page's existing
 * TileSection ahead of "Running", and absent when nothing is unseen. The
 * selector itself is pinned in lib; what lives here is the page wiring —
 * ordering, the owner-only exclusion, and hide-when-empty.
 */

function subshell(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: null,
    harnessId: "claude-code",
    nodeId: "local",
    nodeOffline: false,
    name: "s1",
    workingDir: "/Users/theo",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    preview: [],
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    nameLocked: false,
    notify: true,
    waitingSince: null,
    access: "owner",
    shareCount: 0,
    sharedWithEveryone: false,
    ...over,
  } as SubshellView;
}

function mount(subshells: SubshellView[]): () => void {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/subshells")
      ? subshells
      : url.includes("/api/nodes")
        ? // The card's node pill reads `useNodes()` (`GET /api/nodes`), whose
          // shape is the `{ nodes }` envelope, not a bare array.
          { nodes: [] }
        : url.includes("/api/settings/public")
          ? { viewerIsAdmin: false, instanceName: "Test plane" }
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
    openLaunch: () => {},
    openNewWorkspace: () => {},
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  // The REAL route object re-parented under a bare root (the nodes-detail
  // idiom): `Route.useSearch()` inside the page resolves against this exact
  // object, so a reconstructed `createRoute` carrying the component would
  // detach the `?view=` search-param wiring. `/subshells/$id` exists only as a
  // Link target for the cards the page renders.
  const homeRoute = Route.update({ id: "/", path: "/", getParentRoute: () => rootRoute } as any);
  const subRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/subshells/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, subRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return () => {
    spy.mockRestore();
    setFetchRouter(null);
  };
}

/** The tiled sections' headings, in rendered order. */
async function headings(): Promise<string[]> {
  await waitFor(() => {
    const hs = [...document.querySelectorAll("h2")].map((h) => h.textContent ?? "");
    expect(hs.length).toBeGreaterThan(0);
    return hs;
  });
  return [...document.querySelectorAll("h2")].map((h) => h.textContent ?? "");
}

afterEach(cleanup);

describe("home Needs Attention section (spec 2026-09-24)", () => {
  it("renders above Running and holds the unseen owner rows", async () => {
    const restore = mount([
      subshell({ id: "a", name: "waiting", unseenPush: true }),
      subshell({ id: "b", name: "seen", unseenPush: false }),
    ]);
    try {
      const hs = await headings();
      expect(hs[0]).toBe("Needs Attention");
      expect(hs).toContain("Running");
      const attention = [...document.querySelectorAll("section")].find(
        (s) => s.querySelector("h2")?.textContent === "Needs Attention",
      );
      expect(attention?.textContent).toContain("waiting");
      expect(attention?.textContent).not.toContain("seen");
    } finally {
      restore();
    }
  });

  it("is absent entirely when nothing is unseen", async () => {
    const restore = mount([subshell({ id: "a", name: "only", unseenPush: false })]);
    try {
      const hs = await headings();
      expect(hs).not.toContain("Needs Attention");
      expect(hs).toContain("Running");
    } finally {
      restore();
    }
  });

  it("excludes a grantee's unseen row from the owner's section", async () => {
    const restore = mount([subshell({ id: "a", name: "shared", unseenPush: true, access: "view" })]);
    try {
      const hs = await headings();
      expect(hs).not.toContain("Needs Attention");
      // The row itself is still a viewer-visible Running card — what the
      // selector excludes is the SPOTLIGHT, not the pane. Without this the
      // test's meaning would silently shift if filterSubshells ever dropped
      // non-owner rows before the selector saw them.
      expect(hs).toContain("Running");
    } finally {
      restore();
    }
  });
});
