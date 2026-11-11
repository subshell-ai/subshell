import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewWorkspaceDialog } from "@/components/sidebar/new-workspace-dialog";
import { WORKSPACES_QUERY_KEY } from "@/hooks/use-workspaces";
import type { WorkspaceRow } from "@/types/workspace";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

interface Call {
  method: string;
  url: string;
  body?: string;
}

function mockFetch(opts: { taken?: WorkspaceRow[]; failCreate?: boolean } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (method === "GET" && url.pathname === "/api/workspaces") {
      return Response.json(opts.taken ?? []);
    }
    if (method === "POST" && url.pathname === "/api/workspaces") {
      return opts.failCreate
        ? Response.json({ message: "Create failed" }, { status: 500 })
        : Response.json({ id: "ws-new" });
    }
    return Response.json({}, { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

const workspace = (id: string, name: string): WorkspaceRow => ({
  id,
  name,
  layout: null,
  subshellCount: 0,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
});

/**
 * Seeds the workspace list so the default name's de-dupe sees it at open,
 * which is the warm-cache state the sidebar leaves behind in the app.
 */
async function renderDialog(opts: { taken?: WorkspaceRow[] } = {}, onOpenChange: (open: boolean) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (opts.taken !== undefined) {
    client.setQueryDefaults(WORKSPACES_QUERY_KEY, { staleTime: Infinity });
    client.setQueryData(WORKSPACES_QUERY_KEY, opts.taken);
  }
  const rootRoute = createRootRoute();
  // Route-component mount (not RouterProvider children — those only render
  // while the router loads; the launch-dialog test carries the same note).
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <NewWorkspaceDialog open onOpenChange={onOpenChange} />,
  });
  const wsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, wsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const settled = Promise.withResolvers<void>();
  setTimeout(settled.resolve, 50);
  await act(async () => {
    await settled.promise;
  });
  return router;
}

const nameField = () => screen.getByLabelText("Workspace name") as HTMLInputElement;

describe("NewWorkspaceDialog", () => {
  it("prefills a unique default name and creates the workspace with it", async () => {
    const stamp = "Sep 27, 7:37 AM";
    const timeSpy = spyOn(Date.prototype, "toLocaleString").mockReturnValue(stamp);
    const { calls, restore } = mockFetch({ taken: [workspace("w1", stamp)] });
    let closed = false;
    try {
      await renderDialog({ taken: [workspace("w1", stamp)] }, (open) => {
        closed = !open;
      });
      await waitFor(() => expect(nameField().value).toBe(`${stamp} (2)`));
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      await waitFor(() => expect(closed).toBe(true));
      const post = calls.find((call) => call.method === "POST" && call.url === "/api/workspaces");
      expect(JSON.parse(post?.body ?? "{}")).toEqual({ name: `${stamp} (2)` });
    } finally {
      timeSpy.mockRestore();
      restore();
    }
  });

  it("keeps Create disabled until the name has non-blank content", async () => {
    const { restore } = mockFetch();
    try {
      await renderDialog();
      await waitFor(() => expect(nameField().value).not.toBe(""));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Create workspace" }).getAttribute("aria-disabled")).not.toBe("true"),
      );
      fireEvent.focus(nameField());
      fireEvent.change(nameField(), { target: { value: "   " } });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Create workspace" }).getAttribute("aria-disabled")).toBe("true"),
      );
      // The caret rule: no complaint while the caret is in the field.
      expect(screen.queryByText("Enter a workspace name.")).toBeNull();
      fireEvent.blur(nameField());
      expect(screen.getByRole("alert").textContent).toBe("Enter a workspace name.");
      fireEvent.change(nameField(), { target: { value: "Team" } });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Create workspace" }).getAttribute("aria-disabled")).not.toBe("true"),
      );
      expect(screen.queryByText("Enter a workspace name.")).toBeNull();
    } finally {
      restore();
    }
  });

  it("normalizes the name the server would normalize", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog();
      fireEvent.change(nameField(), { target: { value: "  Team   A  " } });
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      await waitFor(() =>
        expect(calls.some((call) => call.method === "POST" && call.url === "/api/workspaces")).toBe(true),
      );
      const post = calls.find((call) => call.method === "POST" && call.url === "/api/workspaces");
      expect(JSON.parse(post?.body ?? "{}")).toEqual({ name: "Team A" });
    } finally {
      restore();
    }
  });

  it("caps the name at the server's 120 characters", async () => {
    const { restore } = mockFetch();
    try {
      await renderDialog();
      expect(nameField().maxLength).toBe(120);
    } finally {
      restore();
    }
  });

  it("a failed create keeps the dialog open with the message", async () => {
    const { restore } = mockFetch({ failCreate: true });
    try {
      await renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      expect(await screen.findByText(/Create failed/)).toBeTruthy();
      expect(screen.getByLabelText("Workspace name")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Create workspace" }).getAttribute("aria-disabled")).not.toBe("true");
    } finally {
      restore();
    }
  });

  it("Cancel closes the dialog", async () => {
    const { restore } = mockFetch();
    let closed = false;
    try {
      await renderDialog({}, (open) => {
        closed = !open;
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(closed).toBe(true);
    } finally {
      restore();
    }
  });
});
