import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { pickWorkspace, SubshellWorkspaceLink } from "@/components/subshell-workspace-link";
import { SUBSHELL_WORKSPACES_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

function row(over: Partial<WorkspaceRow> & { id: string }): WorkspaceRow {
  return {
    name: over.id,
    layout: null,
    subshellCount: 2,
    draft: false,
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    ...over,
  };
}

/**
 * Renders inside a throwaway router (the link needs router context) with the
 * subshell's workspaces already in cache, so nothing fetches.
 */
function renderLink(workspaces: WorkspaceRow[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData([...SUBSHELL_WORKSPACES_QUERY_KEY, "s1"], workspaces);
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <QueryClientProvider client={qc}>
        <SubshellWorkspaceLink subshellId="s1" />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("pickWorkspace", () => {
  it("prefers a draft over every saved workspace, however recent", () => {
    const picked = pickWorkspace([
      row({ id: "saved", updatedAt: "2026-09-14T12:00:00.000Z" }),
      row({ id: "draft", draft: true, updatedAt: "2026-09-14T09:00:00.000Z" }),
    ]);
    expect(picked?.id).toBe("draft");
  });

  it("picks the most recently updated saved workspace", () => {
    const picked = pickWorkspace([
      row({ id: "old", updatedAt: "2026-09-13T10:00:00.000Z" }),
      row({ id: "new", updatedAt: "2026-09-14T11:00:00.000Z" }),
    ]);
    expect(picked?.id).toBe("new");
  });

  it("answers null when the subshell is on none", () => {
    expect(pickWorkspace([])).toBeNull();
  });
});

describe("SubshellWorkspaceLink", () => {
  afterEach(cleanup);

  it("renders nothing when the subshell is on no workspace", () => {
    renderLink([]);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("offers the unsaved workspace by that name, never by its placeholder", async () => {
    renderLink([row({ id: "w1", name: "Sep 14, 4:45 PM", draft: true })]);
    const link = await screen.findByRole("link", { name: "Open the unsaved workspace this subshell is on" });
    expect(link.getAttribute("href")).toBe("/workspaces/w1");
    expect(screen.getByText("Open unsaved workspace")).toBeTruthy();
    expect(screen.queryByText(/Sep 14/)).toBeNull();
  });

  it("names a saved workspace", async () => {
    renderLink([row({ id: "w2", name: "Rewrite" })]);
    const link = await screen.findByRole("link", { name: "Open workspace Rewrite" });
    expect(link.getAttribute("href")).toBe("/workspaces/w2");
    expect(screen.getByText("In “Rewrite”")).toBeTruthy();
  });
});
