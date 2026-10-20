import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar";
import { QuickAddProvider } from "@/components/quick-add";
import { SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";
import { setFetchRouter } from "@/test-setup";

const dragImage = spyOn(DataTransfer.prototype, "setDragImage").mockImplementation(() => {});
afterAll(() => dragImage.mockRestore());

function transfer(id: string, type = SUBSHELL_DND_TYPE) {
  const values: Record<string, string> = { [type]: id };
  return {
    types: [type],
    getData: (key: string) => values[key] ?? "",
    setData: (key: string, value: string) => {
      values[key] = value;
    },
    effectAllowed: "",
    dropEffect: "",
  };
}
async function mount(count = 2, refuse = false) {
  const requests: string[] = [];
  let panes = Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    subshellId: `s${i + 1}`,
    subshellName: `Member ${i + 1}`,
    workingDir: "/project",
  }));
  const subshells = ["s1", "s2", "outside"].map((id, i) => ({
    id,
    name: i < 2 ? `Member ${i + 1}` : "Other agent",
    workingDir: "/project",
    harnessId: "terminal",
    status: "running",
    alive: true,
    activity: "idle",
    access: "owner",
    nodeId: "local",
    createdAt: "2026-10-20T00:00:00Z",
    waitingSince: null,
  }));
  setFetchRouter(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") {
      requests.push(`${init.method} ${url.pathname}`);
      if (refuse) return Response.json({ message: "Cannot remove pane" }, { status: 500 });
      panes = panes.filter((p) => !url.pathname.endsWith(p.id));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/workspaces")
      return Response.json([
        { id: "w1", name: "Task board", panes, subshellCount: panes.length, updatedAt: "2026-10-20" },
      ]);
    if (url.pathname === "/api/subshells/subagents") return Response.json({});
    if (url.pathname === "/api/subshells")
      return Response.json(
        subshells.filter(
          (s) =>
            !url.searchParams.get("q") ||
            s.name.toLowerCase().includes((url.searchParams.get("q") ?? "").toLowerCase()),
        ),
      );
    if (url.pathname === "/api/nodes") return Response.json({ nodes: [{ id: "local", name: "Server" }] });
    if (url.pathname === "/api/plugins") return Response.json({ plugins: [] });
    if (url.pathname.includes("get-session")) return Response.json({ user: { id: "u", name: "Test" } });
    if (url.pathname === "/api/settings/public") return Response.json({ viewerIsAdmin: false });
    return Response.json([]);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QuickAddProvider>
        <AppSidebar />
      </QuickAddProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/workspaces/$id", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/workspaces/w1"] }),
  });
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("link", { name: /Other agent/ });
  const add = result.container.querySelector('[data-sidebar-drop="add"]') as HTMLElement;
  const remove = result.container.querySelector('[data-sidebar-drop="remove"]') as HTMLElement;
  return { router, requests, add, remove };
}
afterEach(() => {
  cleanup();
  setFetchRouter(null);
  localStorage.clear();
});

test("shows workspace members and other subshells once in a single panel", async () => {
  const { add, remove } = await mount();
  expect(within(add).getAllByRole("link", { name: /Member/ })).toHaveLength(2);
  expect(within(remove).queryByRole("link", { name: /Member/ })).toBeNull();
  expect(within(remove).getByRole("link", { name: /Other agent/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Subshells" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Workspaces" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
});
test("dragging out removes membership only and moves the row to Other subshells", async () => {
  const { add, remove, requests } = await mount();
  const row = within(add).getByRole("link", { name: /Member 2/ });
  const dt = transfer("s2");
  fireEvent.dragStart(row, { dataTransfer: dt });
  expect(within(remove).getByRole("status").textContent).toBe("Remove from workspace");
  fireEvent.dragOver(remove, { dataTransfer: dt });
  fireEvent.drop(remove, { dataTransfer: dt });
  await waitFor(() => expect(within(remove).getByRole("link", { name: /Member 2/ })).toBeTruthy());
  expect(requests).toEqual(["DELETE /api/workspaces/w1/panes/p2"]);
  expect(within(add).queryByRole("link", { name: /Member 2/ })).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});
test("dragging in uses the existing add-as-tab intent without leaving the workspace", async () => {
  const { add, remove, router } = await mount();
  const dt = transfer("outside");
  fireEvent.dragStart(within(remove).getByRole("link", { name: /Other agent/ }), { dataTransfer: dt });
  expect(within(add).getByRole("status").textContent).toBe("Add to workspace");
  fireEvent.drop(add, { dataTransfer: dt });
  await waitFor(() => expect(router.state.location.search).toEqual({ add: "outside", dir: "within" }));
  expect(router.state.location.pathname).toBe("/workspaces/w1");
});
test("protects the last tab and ignores unrelated drag payloads", async () => {
  const { add, remove, requests } = await mount(1);
  const dt = transfer("s1");
  fireEvent.dragStart(within(add).getByRole("link", { name: /Member 1/ }), { dataTransfer: dt });
  expect(within(remove).getByRole("status").textContent).toContain("last tab");
  fireEvent.drop(remove, { dataTransfer: dt });
  expect(requests).toEqual([]);
  fireEvent.dragOver(remove, { dataTransfer: transfer("s1", "Files") });
  fireEvent.drop(remove, { dataTransfer: transfer("s1", "Files") });
  expect(requests).toEqual([]);
});
test("failed removal keeps the membership and last-tab safety intact", async () => {
  const { add, remove, requests } = await mount(2, true);
  const dt = transfer("s2");
  fireEvent.dragStart(within(add).getByRole("link", { name: /Member 2/ }), { dataTransfer: dt });
  fireEvent.drop(remove, { dataTransfer: dt });
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(within(add).getByRole("link", { name: /Member 2/ })).toBeTruthy();
  expect(within(remove).queryByRole("link", { name: /Member 2/ })).toBeNull();
});
