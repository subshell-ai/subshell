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
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import type { SubshellView } from "@/types/subshell";

/**
 * The rail row carries four consumers on ONE element: nav, drag, the
 * right-click menu, and — since 2026-09-24 — the tooltip. The tooltip moved
 * off the native `title` because the browser paints native tooltips at the
 * SYSTEM font size, so ctrl +/- scaled the rail and left the reveal behind;
 * an in-page popup scales with the page. What is pinned here is the merge
 * itself — the tooltip's trigger attributes land ON the Link rather than on
 * a wrapper (the thing the old native choice dodged, and the reason the
 * gesture trio survives), and no `title` is left to double-draw. Hover is
 * not reproducible under happy-dom (floating-ui's hover hook needs the
 * pointer event stack a real browser provides), but the tooltip's FOCUS path
 * opens the same popup and is — so the detail string and the size step are
 * asserted as rendered here, and the whole path was verified by mouse, at
 * 100% and 200% zoom, in a real browser against the e2e stack (2026-09-24).
 */
function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: "p1",
    harnessId: "claude",
    nodeId: "mac",
    nodeOffline: false,
    name: "auth-refactor",
    nameLocked: false,
    workingDir: "/home/theo/projects/auth",
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    unseenPush: false,
    access: "owner",
    ...overrides,
  };
}

function mockFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/presets") return Promise.resolve(new Response(JSON.stringify([])));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

function renderRow(subshell: SubshellView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <SubshellRecentRow subshell={subshell} active={false} nodeLabel="mac mini" agentLabel="Claude Code" />
    ),
  });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  // mockFetch restores in each test's finally; nothing else to undo.
});

describe("SubshellRecentRow tooltip (2026-09-24: in-page, so it zooms)", () => {
  it("merges the tooltip trigger onto the Link itself, not a wrapper", async () => {
    const restore = mockFetch();
    try {
      renderRow(makeSubshell());
      const link = await screen.findByRole("link", { name: /auth-refactor/ });
      // Base UI stamps its trigger identifier on the trigger element — the
      // Link, via `render`. A wrapper element instead would be the shape
      // that used to break one of the row's other gestures.
      expect(link.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
      fireEvent.focus(link);
      // Anchor on the bolded label, then walk up to the popup: labels and
      // values are separate spans now (TooltipLabelledLines), so no single
      // element carries a whole line any more.
      const nameLabel = await screen.findByText("Name:");
      const popup = nameLabel.closest("[class*='bg-popover']");
      expect(popup).not.toBeNull();
      expect(popup?.textContent).toContain("Name: auth-refactor");
      expect(popup?.textContent).toContain("Node: mac mini");
      expect(popup?.textContent).toContain("Directory: /home/theo/projects/auth");
      // One step up the scale (operator call): body, not detail.
      expect(popup?.closest("[class*='text-body']")).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("leaves the row a Link: href, draggable, and no native title", async () => {
    const restore = mockFetch();
    try {
      renderRow(makeSubshell());
      const link = await screen.findByRole("link", { name: /auth-refactor/ });
      expect(link.getAttribute("href")).toBe("/subshells/s1");
      expect(link.getAttribute("draggable")).toBe("true");
      // The native reveal is GONE — leaving both would double-draw a tooltip.
      expect(link.getAttribute("title")).toBeNull();
      await waitFor(() => expect(screen.getByRole("link")).toBeTruthy());
    } finally {
      restore();
    }
  });
});
