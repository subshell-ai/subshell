import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import * as quickAdd from "@/components/quick-add";
import { AllSubshellsSection } from "@/components/sidebar/all-subshells-section";
import { setFetchRouter } from "@/test-setup";

/**
 * The Subshells section's EMPTY state is one quiet line, not a card (operator
 * ruling 2026-10-20). The section's own header menu already carries "Add
 * subshell", so the old dashed card with its filled CTA was a competing call to
 * action inside a nav rail. These tests pin the idiom the Workspaces section
 * uses: one muted paragraph, both sentences, and no button of the section's
 * own sitting in the empty area.
 */

const spy = () =>
  spyOn(quickAdd, "useQuickAdd").mockReturnValue({
    openLaunch: () => {},
    openSshLaunch: () => {},
    openNewWorkspace: () => {},
  });

async function renderSection(excludeIds?: ReadonlySet<string>): Promise<void> {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = url.includes("/api/subshells")
      ? []
      : url.includes("/api/workspaces")
        ? []
        : url.includes("/api/nodes")
          ? { nodes: [] }
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <AllSubshellsSection excludeIds={excludeIds} /> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await act(async () => {
    for (let tick = 0; tick < 3; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
});

describe("the Subshells section's empty state", () => {
  it("shows one quiet line and no CTA when the instance has none", async () => {
    const quick = spy();
    try {
      await renderSection();
      const line = await screen.findByText(/No subshells yet/);
      expect(line.tagName).toBe("P");
      expect(line.textContent).toBe("No subshells yet. Start an agent or a terminal session to get going.");
      // Quiet: muted detail text, no strong heading, no dashed card.
      expect(line.className).toContain("text-muted-foreground");
      expect(line.className).not.toContain("font-strong");
      // No competing call to action: the section header's menu owns that act.
      expect(screen.queryByRole("button", { name: "Add subshell" })).toBeNull();
    } finally {
      quick.mockRestore();
    }
  });

  it("says so quietly when every subshell is already a member", async () => {
    const quick = spy();
    try {
      await renderSection(new Set(["s1"]));
      const line = await screen.findByText(/Drag a subshell here/);
      expect(line.textContent).toBe("Drag a subshell here to remove it from the workspace.");
      expect(screen.queryByRole("button", { name: "Add subshell" })).toBeNull();
    } finally {
      quick.mockRestore();
    }
  });
});
