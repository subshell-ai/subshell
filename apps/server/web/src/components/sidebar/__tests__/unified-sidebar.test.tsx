import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar";
import { QuickAddProvider } from "@/components/quick-add";
import { WORKSPACES_QUERY_KEY } from "@/hooks/use-workspaces";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";
import { resetWorkspaceFocusForTests, setWorkspaceFocusedId } from "@/lib/workspace-focus";
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
    if (init?.method === "POST" && url.pathname === "/api/workspaces/w1/panes") {
      requests.push(`POST ${url.pathname}`);
      const { subshellId } = JSON.parse(String(init.body));
      panes.push({ id: "added", subshellId, subshellName: "Other agent", workingDir: "/project" });
      return Response.json({ id: "added" });
    }
    if (init?.method === "DELETE") {
      requests.push(`${init.method} ${url.pathname}`);
      if (refuse) return Response.json({ message: "Cannot remove pane" }, { status: 500 });
      // The server retires a workspace when its last pane goes (ruling
      // 2026-10-20), and the retired row leaves the LIST the same moment.
      const retiring = panes.length === 1 && url.pathname.endsWith(panes[0].id);
      panes = panes.filter((p) => !url.pathname.endsWith(p.id));
      return Response.json({ ok: true, workspaceDeleted: retiring });
    }
    if (url.pathname === "/api/workspaces")
      return Response.json(
        panes.length > 0
          ? [{ id: "w1", name: "Task board", panes, subshellCount: panes.length, updatedAt: "2026-10-20" }]
          : [],
      );
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
      createRoute({ getParentRoute: () => root, path: "/subshells", component: () => null }),
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
  resetWorkspaceFocusForTests();
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
test("dragging in persists membership without a navigation intent", async () => {
  const { add, remove, router, requests } = await mount();
  const dt = transfer("outside");
  fireEvent.dragStart(within(remove).getByRole("link", { name: /Other agent/ }), { dataTransfer: dt });
  expect(within(add).getByRole("status").textContent).toBe("Add to workspace");
  fireEvent.drop(add, { dataTransfer: dt });
  await waitFor(() => expect(within(add).getByRole("link", { name: /Other agent|Renamed outside/ })).toBeTruthy());
  expect(router.state.location.search).toEqual({});
  expect(router.state.location.pathname).toBe("/workspaces/w1");
  expect(requests).toEqual(["POST /api/workspaces/w1/panes"]);
});
test("ignores unrelated drag payloads and retires the workspace on the last removal", async () => {
  // Ruling 2026-10-20: dragging the LAST member out is no longer refused.
  // The removal retires the workspace (the subshell keeps running, unfiled),
  // and because the retired row is the page on screen, the drop handler
  // leaves it for the Subshells list.
  const { add, remove, requests, router } = await mount(1);
  fireEvent.dragOver(remove, { dataTransfer: transfer("s1", "Files") });
  fireEvent.drop(remove, { dataTransfer: transfer("s1", "Files") });
  expect(requests).toEqual([]);
  const dt = transfer("s1");
  fireEvent.dragStart(within(add).getByRole("link", { name: /Member 1/ }), { dataTransfer: dt });
  expect(within(remove).getByRole("status").textContent).toBe("Remove from workspace");
  fireEvent.drop(remove, { dataTransfer: dt });
  await waitFor(() => expect(requests).toEqual(["DELETE /api/workspaces/w1/panes/p1"]));
  await waitFor(() => expect(router.state.location.pathname).toBe("/subshells"));
});
test("failed removal keeps the membership intact", async () => {
  const { add, remove, requests } = await mount(2, true);
  const dt = transfer("s2");
  fireEvent.dragStart(within(add).getByRole("link", { name: /Member 2/ }), { dataTransfer: dt });
  fireEvent.drop(remove, { dataTransfer: dt });
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(within(add).getByRole("link", { name: /Member 2/ })).toBeTruthy();
  expect(within(remove).queryByRole("link", { name: /Member 2/ })).toBeNull();
});

/**
 * The deep/state probes below drive the transitions the surface-level pins
 * above never exercise: a destination change or a membership change DURING a
 * drag, a rename and a re-order between render and interaction, a replaced
 * pane row under a live focus mark, and name collisions between workspaces
 * and subshells. Every fixture mutation goes through `fx` — the same arrays
 * the fetch router reads — followed by a query invalidation, so the rail
 * catches up mid-gesture exactly as it would from a live feed or a second
 * client. One fixture detail matters for the workspace-switch case: w2
 * deliberately SHARES pane s2 with w1 (a pane may sit in several workspaces),
 * which is what makes the wrong-workspace drop a real target rather than a
 * tautology.
 */
interface RigPane {
  id: string;
  subshellId: string;
  subshellName: string;
}
interface RigWs {
  id: string;
  name: string;
  panes: RigPane[];
  updatedAt: string;
}

function rigSubshell(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    workingDir: "/project",
    harnessId: "terminal",
    status: "running",
    alive: true,
    activity: "idle",
    access: "owner",
    nodeId: "local",
    createdAt: "2026-10-20T00:00:00Z",
    waitingSince: null,
    ...over,
  };
}

function standardRig(): { workspaces: RigWs[]; subshells: Record<string, unknown>[] } {
  return {
    workspaces: [
      {
        id: "w1",
        name: "Task board",
        updatedAt: "2026-10-20",
        panes: [
          { id: "p1", subshellId: "s1", subshellName: "Member 1" },
          { id: "p2", subshellId: "s2", subshellName: "Member 2" },
        ],
      },
      {
        id: "w2",
        name: "Shared board",
        updatedAt: "2026-10-19",
        panes: [
          { id: "q2", subshellId: "s2", subshellName: "Member 2" },
          { id: "q3", subshellId: "s9", subshellName: "Board nine" },
        ],
      },
    ],
    subshells: [
      rigSubshell("s1", "Member 1"),
      rigSubshell("s2", "Member 2"),
      rigSubshell("s9", "Board nine"),
      rigSubshell("outside", "Other agent"),
    ],
  };
}

async function mountRig(
  fx: { workspaces: RigWs[]; subshells: Record<string, unknown>[] },
  listState?: "loading" | "error",
  addGate?: Promise<void>,
  removeGate?: Promise<void>,
) {
  const requests: string[] = [];
  setFetchRouter(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "POST" && url.pathname.endsWith("/panes")) {
      requests.push(`POST ${url.pathname}`);
      const target = fx.workspaces.find((w) => w.id === url.pathname.split("/")[3]);
      const { subshellId } = JSON.parse(String(init.body));
      await addGate;
      target?.panes.push({
        id: "added",
        subshellId,
        subshellName: String(fx.subshells.find((s) => s.id === subshellId)?.name),
      });
      return Response.json({ id: "added" });
    }
    if (init?.method === "DELETE") {
      requests.push(`${init.method} ${url.pathname}`);
      await removeGate;
      const parts = url.pathname.split("/"); // ["", "api", "workspaces", ws, "panes", pane]
      const ws = fx.workspaces.find((w) => w.id === parts[3]);
      if (ws) ws.panes = ws.panes.filter((p) => p.id !== parts[5]);
      const workspaceDeleted = ws?.panes.length === 0;
      if (workspaceDeleted) fx.workspaces = fx.workspaces.filter((w) => w !== ws);
      return Response.json({ ok: true, workspaceDeleted });
    }
    if (url.pathname === "/api/workspaces")
      return Response.json(
        fx.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          panes: w.panes,
          subshellCount: w.panes.length,
          updatedAt: w.updatedAt,
        })),
      );
    if (url.pathname === "/api/subshells/subagents") return Response.json({});
    if (url.pathname === "/api/subshells" && listState === "loading") return new Promise<Response>(() => {});
    if (url.pathname === "/api/subshells" && listState === "error")
      return Response.json({ message: "Unavailable" }, { status: 503 });
    if (url.pathname === "/api/subshells")
      return Response.json(
        fx.subshells.filter(
          (s) =>
            !url.searchParams.get("q") ||
            String(s.name)
              .toLowerCase()
              .includes((url.searchParams.get("q") ?? "").toLowerCase()),
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
      createRoute({ getParentRoute: () => root, path: "/subshells/$id", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/subshells", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/workspaces/w1"] }),
  });
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // The router's first commit precedes its location load, so the contextual
  // panel — and with it the drop areas — lands one tick after render(). Wait
  // on it before grabbing the elements (the same reason `mount` above waits
  // on a row).
  await screen.findByLabelText("Switch workspace");
  const add = result.container.querySelector('[data-sidebar-drop="add"]') as HTMLElement;
  const remove = result.container.querySelector('[data-sidebar-drop="remove"]') as HTMLElement;
  const refresh = async (key: readonly unknown[]) => {
    await act(async () => {
      await client.invalidateQueries({ queryKey: [...key] });
    });
  };
  return { router, client, requests, add, remove, fx, refresh };
}

test("a workspace switch mid-drag ends the gesture and nothing transfers into the new workspace", async () => {
  const { router, requests, add, remove } = await mountRig(standardRig());
  const row = await within(add).findByRole("link", { name: /Member 2/ });
  const dt = transfer("s2");
  fireEvent.dragStart(row, { dataTransfer: dt });
  expect(within(remove).getByRole("status").textContent).toBe("Remove from workspace");
  // Mid-drag the rail moves to the workspace that ALSO holds s2. Its remove
  // area would otherwise gladly accept the drop — with the destination-change
  // guard in place, the gesture ends the moment its destination moves.
  await act(async () => {
    await router.navigate({ to: "/workspaces/$id", params: { id: "w2" } });
  });
  await waitFor(() => expect(within(remove).queryByRole("status") === null).toBe(true));
  fireEvent.drop(remove, { dataTransfer: dt });
  await new Promise((r) => setTimeout(r, 20));
  // Without the guard this DELETEs /api/workspaces/w2/panes/q2 — a pane
  // removed from a workspace the person never meant to touch.
  expect(requests).toEqual([]);
});

test("an outside membership change mid-drag retracts the remove offer and the drop does nothing", async () => {
  const rig = await mountRig(standardRig());
  const { requests, add, remove, refresh } = rig;
  const row = await within(add).findByRole("link", { name: /Member 2/ });
  const dt = transfer("s2");
  fireEvent.dragStart(row, { dataTransfer: dt });
  expect(within(remove).getByRole("status").textContent).toBe("Remove from workspace");
  // Another client closes the pane; the live list catches up mid-drag.
  const w1 = rig.fx.workspaces.find((w) => w.id === "w1")!;
  w1.panes = w1.panes.filter((p) => p.id !== "p2");
  await refresh(WORKSPACES_QUERY_KEY);
  // The offer follows the live truth: nothing is offered as a removal now.
  await waitFor(() => expect(within(remove).queryByRole("status") === null).toBe(true));
  expect(within(add).getByRole("status").textContent).toBe("Add to workspace");
  fireEvent.drop(remove, { dataTransfer: dt });
  await new Promise((r) => setTimeout(r, 20));
  // No phantom removal of a pane row that changed underneath the drag.
  expect(requests).toEqual([]);
});

test("dropping a member row onto the add area files nothing", async () => {
  const { router, requests, add } = await mountRig(standardRig());
  const row = await within(add).findByRole("link", { name: /Member 2/ });
  const dt = transfer("s2");
  fireEvent.dragStart(row, { dataTransfer: dt });
  // The add offer is for non-members only; a member row over the add area
  // sees no offer and its drop resolves to nothing.
  expect(within(add).queryByRole("status") === null).toBe(true);
  fireEvent.drop(add, { dataTransfer: dt });
  await new Promise((r) => setTimeout(r, 20));
  expect(requests).toEqual([]);
  expect(router.state.location.search).toEqual({});
});

test("a rename and a re-order after render do not change what the drag carries", async () => {
  const rig = await mountRig(standardRig());
  const { router, add, remove, refresh } = rig;
  await within(remove).findByRole("link", { name: /Other agent/ });
  // The live feed renames the row and a waiting pane sorts above it.
  const other = rig.fx.subshells.find((s) => s.id === "outside")!;
  other.name = "Renamed outside";
  rig.fx.subshells.push(rigSubshell("s5", "Waiting pane", { waitingSince: "2026-10-20T00:00:30Z" }));
  await refresh(SUBSHELLS_QUERY_KEY);
  const row = await within(remove).findByRole("link", { name: /Renamed outside/ });
  const dt = transfer("outside");
  fireEvent.dragStart(row, { dataTransfer: dt });
  fireEvent.drop(add, { dataTransfer: dt });
  // The pane mutation speaks the id, and the id survives both the rename and
  // the reorder.
  await waitFor(() => expect(rig.requests).toEqual(["POST /api/workspaces/w1/panes"]));
  expect(router.state.location.search).toEqual({});
});

test("a replaced pane row keeps the focused mark: focus is a subshell id, not a row", async () => {
  setWorkspaceFocusedId("s2");
  const rig = await mountRig(standardRig());
  const { add, refresh } = rig;
  await within(add).findByRole("link", { name: /Member 2/ });
  expect(add.querySelector("a.ring-1")?.getAttribute("href")).toBe("/subshells/s2");
  // Another client closes the pane and files the same subshell again: the
  // pane row is a NEW row id for the same subshell.
  const w1 = rig.fx.workspaces.find((w) => w.id === "w1")!;
  w1.panes = [
    { id: "p1", subshellId: "s1", subshellName: "Member 1" },
    { id: "p9", subshellId: "s2", subshellName: "Member 2" },
  ];
  await refresh(WORKSPACES_QUERY_KEY);
  await waitFor(() => expect(add.querySelectorAll("a.ring-1").length).toBe(1));
  const rows = within(add).getAllByRole("link", { name: /Member 2/ });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.getAttribute("href")).toBe("/subshells/s2");
});

test("rows sharing a name stay keyed by their id in the branch and the list", async () => {
  const { router, add, remove } = await mountRig({
    workspaces: [
      {
        id: "w1",
        name: "Task board",
        updatedAt: "2026-10-20",
        panes: [{ id: "a1", subshellId: "t1", subshellName: "Twin agent" }],
      },
      {
        id: "w2",
        name: "Task board",
        updatedAt: "2026-10-19",
        panes: [{ id: "b1", subshellId: "t2", subshellName: "Twin agent" }],
      },
    ],
    subshells: [rigSubshell("t1", "Twin agent"), rigSubshell("t2", "Twin agent")],
  });
  await within(add).findByRole("link", { name: /Twin agent/ });
  // Two rows, one name, two workspaces named alike: only the ids tell them
  // apart, and every action below rides the id.
  expect(
    within(add)
      .getByRole("link", { name: /Twin agent/ })
      .getAttribute("href"),
  ).toBe("/subshells/t1");
  expect(
    within(remove)
      .getByRole("link", { name: /Twin agent/ })
      .getAttribute("href"),
  ).toBe("/subshells/t2");
  // The other same-named workspace: the branch follows the URL's id.
  await act(async () => {
    await router.navigate({ to: "/workspaces/$id", params: { id: "w2" } });
  });
  await waitFor(() =>
    expect(
      within(add)
        .getByRole("link", { name: /Twin agent/ })
        .getAttribute("href"),
    ).toBe("/subshells/t2"),
  );
});

/** Base UI popups open on a real pointer gesture; a bare click does not
 *  reach the trigger in happy-dom (the prompt-picker precedent in
 *  new-subshell-form.test.tsx). */
function openWorkspacePicker(): void {
  const trigger = screen.getByLabelText("Switch workspace");
  act(() => {
    for (const type of ["pointerdown", "pointerup"]) {
      trigger.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }));
    }
    for (const type of ["mousedown", "mouseup", "click"]) {
      trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  });
}

/** The SelectGroup that wraps the "New workspace" row in the open picker.
 *  Keyed on Base UI's own rendered role, so the lookup does not depend on the
 *  very classes the assertions below read. */
function newWorkspaceGroup(): HTMLElement {
  const group = screen.getByText("New workspace").closest('[role="group"]');
  if (!group) throw new Error("the New workspace row sits in no group");
  return group as HTMLElement;
}

test("the picker separates New workspace only when there are workspaces above it", async () => {
  // With rows, the divider earns its place: it separates the two groups.
  await mountRig(standardRig());
  openWorkspacePicker();
  await screen.findByText("New workspace");
  expect(newWorkspaceGroup().className).toContain("border-t");
  cleanup();

  // With none, the row stands alone and the group carries none of the
  // separator classes: the List's p-1 insets it evenly on all four sides.
  await mountRig({ workspaces: [], subshells: [] });
  openWorkspacePicker();
  await screen.findByText("New workspace");
  const group = newWorkspaceGroup().className;
  expect(group).not.toContain("border-t");
  expect(group).not.toContain("mt-1");
  expect(group).not.toContain("py-1");
});

test("reveals the ancestors of a selected child without expanding unrelated parents", async () => {
  const fx = standardRig();
  fx.subshells.push(
    rigSubshell("helper", "Selected helper", { crossAgent: true, parentSubshellId: "s1" }),
    rigSubshell("other-helper", "Unselected helper", { crossAgent: true, parentSubshellId: "s2" }),
  );
  fx.workspaces[0]?.panes.push({ id: "helper-pane", subshellId: "helper", subshellName: "Selected helper" });
  setWorkspaceFocusedId("helper");
  const { add } = await mountRig(fx);
  expect(await within(add).findByRole("link", { name: /Selected helper/ })).toBeTruthy();
  expect(within(add).queryByRole("link", { name: /Unselected helper/ }) === null).toBe(true);
});

test("workspace rows group by machine and spawned helpers appear once under their creator", async () => {
  const fx = standardRig();
  fx.subshells = fx.subshells.map((row) => (row.id === "s2" ? { ...row, nodeId: "remote" } : row));
  fx.subshells.push(
    rigSubshell("helper", "Review helper", { crossAgent: true, parentSubshellId: "s1", nodeId: "remote" }),
  );
  const { add, remove, router, refresh } = await mountRig(fx);
  const parentBranch = add.querySelector('[data-subshell-tree-id="s1"]') as HTMLElement;
  fireEvent.click(await within(parentBranch).findByRole("button", { name: "Expand subagents" }));
  await within(add).findByRole("link", { name: /Review helper/ });
  expect(within(add).getByRole("heading", { name: "Server" })).toBeTruthy();
  expect(within(add).getByRole("heading", { name: "node you can't see" })).toBeTruthy();
  const parent = add.querySelector('[data-subshell-tree-id="s1"]') as HTMLElement;
  expect(within(parent).getByRole("link", { name: /Review helper/ })).toBeTruthy();
  expect(within(remove).queryByRole("link", { name: /Review helper/ })).toBeNull();
  fireEvent.click(within(parent).getByRole("link", { name: /Review helper/ }));
  await waitFor(() => expect(router.state.location.search).toMatchObject({ add: "helper", dir: "within" }));
  // Removing a parent never promotes its surviving helper to a standalone entry.
  fx.subshells = fx.subshells.filter((row) => row.id !== "s1");
  await refresh(SUBSHELLS_QUERY_KEY);
  await waitFor(() => expect(within(add).queryByRole("link", { name: /Review helper/ }) === null).toBe(true));
  expect(within(remove).queryByRole("link", { name: /Review helper/ })).toBeNull();
});

for (const listState of ["loading", "error"] as const) {
  test(`never renders unclassified helper placeholders while the list is ${listState}`, async () => {
    const fx = standardRig();
    fx.workspaces[0]!.panes.push({ id: "helper-pane", subshellId: "helper", subshellName: "Hidden helper" });
    const { add } = await mountRig(fx, listState);
    await within(add).findByText(
      listState === "loading" ? "Loading workspace subshells…" : "Couldn’t load workspace subshells.",
    );
    expect(within(add).queryByText("Hidden helper")).toBeNull();
  });
}

test("a drop stays in its target when switching workspaces before the save completes", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { router, add, remove, fx, requests } = await mountRig(standardRig(), undefined, gate);
  const dt = transfer("outside");
  fireEvent.dragStart(await within(remove).findByRole("link", { name: /Other agent/ }), { dataTransfer: dt });
  fireEvent.drop(add, { dataTransfer: dt });
  await waitFor(() => expect(requests).toEqual(["POST /api/workspaces/w1/panes"]));
  try {
    await act(async () => {
      await router.navigate({ to: "/workspaces/$id", params: { id: "w2" }, search: {} });
    });
  } finally {
    await act(async () => {
      release();
      await gate;
    });
  }
  await waitFor(() => expect(fx.workspaces[0].panes.some((p) => p.subshellId === "outside")).toBe(true));
  expect(fx.workspaces[1].panes.some((p) => p.subshellId === "outside")).toBe(false);
  expect(router.state.location.pathname).toBe("/workspaces/w2");
  expect(router.state.location.search).toEqual({});
  await act(async () => {
    await router.navigate({ to: "/workspaces/$id", params: { id: "w1" }, search: {} });
  });
  await waitFor(() => expect(within(add).getByRole("link", { name: /Other agent/ })).toBeTruthy());
});

test("finishing a last-pane removal does not navigate away from a different workspace", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fx = standardRig();
  fx.workspaces[0].panes = [fx.workspaces[0].panes[0]];
  const { router, add, remove, requests } = await mountRig(fx, undefined, undefined, gate);
  const dt = transfer("s1");
  fireEvent.dragStart(await within(add).findByRole("link", { name: /Member 1/ }), { dataTransfer: dt });
  fireEvent.drop(remove, { dataTransfer: dt });
  await waitFor(() => expect(requests).toEqual(["DELETE /api/workspaces/w1/panes/p1"]));
  try {
    await act(async () => {
      await router.navigate({ to: "/workspaces/$id", params: { id: "w2" }, search: {} });
    });
  } finally {
    await act(async () => {
      release();
      await gate;
    });
  }
  await waitFor(() => expect(fx.workspaces.some((w) => w.id === "w1")).toBe(false));
  expect(router.state.location.pathname).toBe("/workspaces/w2");
});

test("removing the last pane leaves the retired workspace after its list row disappears", async () => {
  const fx = standardRig();
  fx.workspaces[0].panes = [fx.workspaces[0].panes[0]];
  const { router, add, remove } = await mountRig(fx);
  const dt = transfer("s1");
  fireEvent.dragStart(await within(add).findByRole("link", { name: /Member 1/ }), { dataTransfer: dt });
  fireEvent.drop(remove, { dataTransfer: dt });
  await waitFor(() => expect(fx.workspaces.some((w) => w.id === "w1")).toBe(false));
  await waitFor(() => expect(router.state.location.pathname).toBe("/subshells"));
});
