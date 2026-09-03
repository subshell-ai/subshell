import { afterEach, describe, expect, it } from "bun:test";
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
import type { SubshellView } from "@/types/subshell";

const subshell = (id: string, name: string): SubshellView =>
  ({
    id,
    name,
    workingDir: `/tmp/${id}`,
    harnessId: "claude",
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    notify: false,
    lastOutputAt: null,
    access: "owner",
  }) as SubshellView;

interface Call {
  method: string;
  url: string;
  body?: string;
}

/**
 * `failPaneAdds`: how many POST …/panes calls answer 500 (the partial-pane
 * failure branch). Serves two subshells so checkbox clicks are real.
 */
function mockFetch(opts: { failPaneAdds?: number } = {}) {
  const calls: Call[] = [];
  let paneFailsLeft = opts.failPaneAdds ?? 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (method === "GET" && url.pathname === "/api/subshells") {
      return new Response(JSON.stringify([subshell("s1", "One"), subshell("s2", "Two")]), { status: 200 });
    }
    if (method === "POST" && url.pathname === "/api/workspaces") {
      return new Response(JSON.stringify({ id: "ws-new" }), { status: 200 });
    }
    if (method === "POST" && url.pathname.startsWith("/api/workspaces/") && url.pathname.endsWith("/panes")) {
      if (paneFailsLeft > 0) {
        paneFailsLeft -= 1;
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: `pane-${calls.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function renderDialog(onOpenChange: (open: boolean) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

afterEach(cleanup);

describe("NewWorkspaceDialog", () => {
  it("zero selected: creates the workspace alone and closes", async () => {
    const { calls, restore } = mockFetch();
    const openChanges: boolean[] = [];
    try {
      await renderDialog((o: boolean) => openChanges.push(o));
      fireEvent.click(await screen.findByRole("button", { name: /Create workspace/i }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/workspaces")).toBe(true));
      expect(calls.some((c) => c.url.endsWith("/panes"))).toBe(false);
      // Success closes the dialog — the callback says `false`, then.
      await waitFor(() => expect(openChanges).toContain(false));
    } finally {
      restore();
    }
  });

  it("selects checkboxes and posts a pane for each", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog();
      fireEvent.click(await screen.findByRole("checkbox", { name: /One/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
      fireEvent.click(screen.getByRole("button", { name: /Create workspace/i }));
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/panes")).length).toBe(2));
      expect(JSON.parse(calls.find((c) => c.url.endsWith("/panes"))?.body ?? "{}")).toEqual({ subshellId: "s1" });
    } finally {
      restore();
    }
  });

  it("partial pane failure: keeps the dialog and offers Enter workspace", async () => {
    const { restore } = mockFetch({ failPaneAdds: 1 });
    try {
      await renderDialog();
      fireEvent.click(await screen.findByRole("checkbox", { name: /One/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
      fireEvent.click(screen.getByRole("button", { name: /Create workspace/i }));
      expect(await screen.findByText(/couldn't add 1 subshell/i)).toBeDefined();
      expect(screen.getByRole("button", { name: /Enter workspace/i })).toBeDefined();
    } finally {
      restore();
    }
  });
});
