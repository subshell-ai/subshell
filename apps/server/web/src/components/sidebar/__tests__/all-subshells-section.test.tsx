import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    openLaunchOnNode: () => {},
    openSshLaunch: () => {},
    openNewWorkspace: () => {},
  });

async function renderSection(excludeIds?: ReadonlySet<string>, withMember = false, withHelpers = false) {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.includes("/api/plugins")) return Response.json({ plugins: [] });
    const body = url.includes("/api/subshells")
      ? withMember && !url.includes("subagents")
        ? [
            {
              id: "s1",
              name: "Member",
              nodeId: "local",
              harnessId: "terminal",
              status: "terminated",
              alive: false,
              workingDir: "/tmp",
              access: "owner",
            },
            ...(withHelpers
              ? [
                  {
                    id: "child",
                    name: "Helper",
                    crossAgent: true,
                    parentSubshellId: "s1",
                    nodeId: "local",
                    harnessId: "terminal",
                    status: "terminated",
                    alive: false,
                    workingDir: "/tmp",
                    access: "owner",
                  },
                  {
                    id: "orphan",
                    name: "Orphan",
                    crossAgent: true,
                    parentSubshellId: null,
                    nodeId: "local",
                    harnessId: "terminal",
                    status: "terminated",
                    alive: false,
                    workingDir: "/tmp",
                    access: "owner",
                  },
                ]
              : []),
          ]
        : []
      : url.includes("/api/workspaces")
        ? withMember
          ? [{ id: "w1", name: "Workspace", panes: [{ subshellId: "s1" }] }]
          : []
        : url.includes("/api/nodes")
          ? { nodes: [] }
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => <AllSubshellsSection excludeIds={excludeIds} workspaceId={withMember ? "w1" : undefined} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: "/workspaces/$id", component: () => null }),
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
  return router;
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

it("keeps the active-workspace marker when rendering a member through the tree", async () => {
  const quick = spy();
  try {
    await renderSection(undefined, true);
    expect(await screen.findByRole("img", { name: "In active workspace" })).toBeTruthy();
  } finally {
    quick.mockRestore();
  }
});

it("renders helpers only under their parent and opens them as tabs", async () => {
  const quick = spy();
  try {
    const router = await renderSection(undefined, true, true);
    const helper = await screen.findByText("Helper");
    expect(helper.closest('[data-subshell-tree-id="s1"]')).not.toBeNull();
    expect(screen.queryByText("Orphan")).toBeNull();
    expect(screen.getAllByText("Helper")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(helper);
    });
    expect(router.state.location.pathname).toBe("/workspaces/w1");
    expect(router.state.location.search).toMatchObject({ add: "child", dir: "within" });
  } finally {
    quick.mockRestore();
  }
});

it("does not promote a helper when its parent is in the workspace section", async () => {
  const quick = spy();
  try {
    await renderSection(new Set(["s1"]), true, true);
    expect(screen.queryByText("Helper")).toBeNull();
    expect(screen.queryByText("Orphan")).toBeNull();
    expect(await screen.findByText(/Drag a subshell here/)).toBeTruthy();
  } finally {
    quick.mockRestore();
  }
});
