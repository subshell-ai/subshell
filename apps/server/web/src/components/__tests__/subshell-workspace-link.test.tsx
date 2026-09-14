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
import { SubshellWorkspaceLink, workspaceLinkView } from "@/components/subshell-workspace-link";
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

describe("workspaceLinkView", () => {
  it("answers null when the subshell is on none", () => {
    expect(workspaceLinkView([])).toBeNull();
  });

  it("names the one saved workspace it is on", () => {
    const view = workspaceLinkView([row({ id: "w1", name: "Rewrite" })]);
    expect(view?.label).toBe("In “Rewrite”");
    expect(view?.options).toEqual([{ id: "w1", label: "Rewrite", draft: false }]);
  });

  it("offers a lone draft by what it IS, never by its placeholder name", () => {
    const view = workspaceLinkView([row({ id: "w1", name: "Sep 14, 4:45 PM", draft: true })]);
    expect(view?.label).toBe("Open unsaved workspace");
    expect(view?.options[0]?.label).toBe("Unsaved workspace");
  });

  // The point of the whole view: a subshell on several workspaces used to
  // offer exactly one of them and say nothing about the rest.
  it("counts them once there is more than one", () => {
    const view = workspaceLinkView([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    expect(view?.label).toBe("In 3 workspaces");
    expect(view?.options.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("puts drafts first, then the most recently updated", () => {
    const view = workspaceLinkView([
      row({ id: "old", updatedAt: "2026-09-13T10:00:00.000Z" }),
      row({ id: "recent", updatedAt: "2026-09-14T18:00:00.000Z" }),
      row({ id: "draft", draft: true, updatedAt: "2026-09-10T10:00:00.000Z" }),
    ]);
    expect(view?.options.map((o) => o.id)).toEqual(["draft", "recent", "old"]);
  });

  // The server already orders by recency, and its timestamps can tie to the
  // millisecond. A stable sort keeps that order rather than shuffling equals.
  it("keeps the server's order among workspaces updated at the same moment", () => {
    const view = workspaceLinkView([row({ id: "first" }), row({ id: "second" }), row({ id: "third" })]);
    expect(view?.options.map((o) => o.id)).toEqual(["first", "second", "third"]);
  });
});

describe("SubshellWorkspaceLink", () => {
  afterEach(cleanup);

  it("renders nothing when the subshell is on no workspace", () => {
    renderLink([]);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("links straight to the workspace when there is only one", async () => {
    renderLink([row({ id: "w2", name: "Rewrite" })]);
    const link = await screen.findByRole("link", { name: "Open workspace Rewrite" });
    expect(link.getAttribute("href")).toBe("/workspaces/w2");
    expect(screen.getByText("In “Rewrite”")).toBeTruthy();
  });

  it("links straight to a lone unsaved workspace", async () => {
    renderLink([row({ id: "w1", name: "Sep 14, 4:45 PM", draft: true })]);
    const link = await screen.findByRole("link", { name: "Open the unsaved workspace this subshell is on" });
    expect(link.getAttribute("href")).toBe("/workspaces/w1");
    expect(screen.queryByText(/Sep 14/)).toBeNull();
  });

  it("counts several and lets the person pick one", async () => {
    renderLink([
      row({ id: "a", name: "Rewrite" }),
      row({ id: "b", name: "Docs" }),
      row({ id: "c", name: "Sep 14, 4:45 PM", draft: true }),
    ]);
    // No single destination, so the control opens rather than navigating.
    const trigger = await screen.findByRole("button", { name: "Show the 3 workspaces this subshell is on" });
    expect(screen.getByText("In 3 workspaces")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(3));
    // The draft leads, named for what it is; every row is a real link, so
    // middle-click and open-in-new-tab keep working.
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Unsaved workspace", "Rewrite", "Docs"]);
    expect(items[0]?.getAttribute("href")).toBe("/workspaces/c");
    expect(items[1]?.getAttribute("href")).toBe("/workspaces/a");
  });
});
