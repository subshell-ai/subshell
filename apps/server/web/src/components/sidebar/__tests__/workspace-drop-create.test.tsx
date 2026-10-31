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
import { QuickAddProvider } from "@/components/quick-add";
import { ActiveWorkspaceSection } from "@/components/sidebar/active-workspace-section";
import { WORKSPACES_QUERY_KEY } from "@/hooks/use-workspaces";
import { SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";
import { beginPointerSubshellDrag, resetPointerDragForTests } from "@/lib/subshell-pointer-drag";
import { resetWorkspaceFocusForTests } from "@/lib/workspace-focus";
import { setFetchRouter } from "@/test-setup";

/**
 * The empty-Workspace drop zone (operator ask, 2026-10-20): when the instance
 * has no workspaces, the Workspace section takes a dragged subshell row and
 * files it the way the split does — a create-with-pane POST and navigation
 * into the new window. The `transfer` stub is the unified-sidebar.test.tsx
 * pattern: happy-dom's DataTransfer carries no custom MIME, so every drop
 * test in this folder stubs the transfer instead of constructing one.
 */

// A dragstart on a real row runs against happy-dom's own DataTransfer (the
// unified-sidebar.test.tsx precedent): its setDragImage throws, so it gets
// the same no-op spy here.
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

interface Rig {
  workspaces: Record<string, unknown>[];
  posts: { body: Record<string, unknown> }[];
  /** "ok" answers, "fail" 500s, "hold" parks the response until release(). */
  mode: "ok" | "fail" | "hold";
  hold: Promise<void>;
  release: () => void;
}

function rig(initial: Record<string, unknown>[] = []): Rig {
  let resolveHold: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    resolveHold = resolve;
  });
  return {
    workspaces: initial,
    posts: [],
    mode: "ok",
    hold,
    release: () => resolveHold(),
  };
}

const SUBSHELLS = [
  {
    id: "s1",
    name: "Loose pane",
    workingDir: "/project",
    harnessId: "terminal",
    status: "running",
    alive: true,
    activity: "idle",
    access: "owner",
    nodeId: "local",
    createdAt: "2026-10-20T00:00:00Z",
    waitingSince: null,
  },
];

async function mount(fx: Rig) {
  setFetchRouter(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/workspaces" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      fx.posts.push({ body });
      if (fx.mode === "hold") await fx.hold;
      // The mode is re-read after the hold: a parked create can be released
      // and answered even though it entered as "hold".
      if (fx.mode === "fail") return Response.json({ message: "Workspace create exploded" }, { status: 500 });
      const created = {
        id: "w9",
        name: body.name,
        subshellCount: 1,
        updatedAt: "2026-10-20",
        panes: [{ id: "p9", subshellId: body.subshellId, subshellName: "Loose pane", workingDir: "/project" }],
      };
      fx.workspaces.push(created);
      return Response.json(created);
    }
    if (url.pathname === "/api/workspaces") return Response.json(fx.workspaces);
    if (init?.method === "DELETE") return Response.json({ ok: true });
    if (url.pathname.includes("subagents")) return Response.json({});
    if (url.pathname === "/api/subshells")
      return Response.json(
        SUBSHELLS.filter(
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
        <ActiveWorkspaceSection />
      </QuickAddProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/workspaces/$id", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/subshells/$id", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // The picker is the first commit; the empty copy below is what proves the
  // workspace read settled (the same wait-on-data reason mountRig waits in
  // unified-sidebar.test.tsx).
  await screen.findByLabelText("Switch workspace");
  // The client rides along so a test can invalidate the workspace read the
  // way a live feed would (the unified-sidebar mountRig pattern).
  return { router, client, container: result.container };
}

/** The drop zone, or null when the section renders none (workspaces exist). */
function zoneOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-workspace-drop="create"]');
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
  localStorage.clear();
  resetWorkspaceFocusForTests();
  // The pointer session is module state; a promoted gesture in this file
  // must leave no armed state or click-swallow for the next file's rows.
  resetPointerDragForTests();
});

test("a subshell drag in flight dresses the zone with a dashed ring, and dragend strips it", async () => {
  const fx = rig();
  const { container } = await mount(fx);
  await screen.findByText("Select a workspace or drag a subshell here to get started.");
  const zone = zoneOf(container) as HTMLElement;
  // The ring rides the GESTURE, not the pointer: a dragstart anywhere arms
  // the target, so the zone says "drop here" while the row is still over
  // the rail. Dispatched on the document, as the real bubble reaches it.
  const dt = transfer("s1");
  fireEvent.dragStart(document, { dataTransfer: dt });
  expect(zone.classList.contains("border-dashed")).toBe(true);
  expect(zone.classList.contains("border-border")).toBe(true);
  // Quiet dashed, not the hover state: primary belongs to pointer-over.
  expect(zone.classList.contains("border-primary")).toBe(false);
  // The label rides the whole gesture, so the words are on screen before
  // the pointer ever reaches the zone.
  expect(within(zone).getByRole("status").textContent).toBe("Drop to create a workspace");
  // dragend ends the gesture however it ended (it fires after a drop too).
  fireEvent.dragEnd(document);
  expect(zone.className.includes("border")).toBe(false);
  expect(within(zone).queryByRole("status") === null).toBe(true);
});

test("a file drag never dresses the rail's create target", async () => {
  const fx = rig();
  const { container } = await mount(fx);
  await screen.findByText("Select a workspace or drag a subshell here to get started.");
  const zone = zoneOf(container) as HTMLElement;
  // The one-MIME gate holds for the in-flight ring too: dockview tab drags
  // and file drops cross this document every day.
  fireEvent.dragStart(document, { dataTransfer: transfer("s1", "Files") });
  expect(zone.className.includes("border")).toBe(false);
  fireEvent.dragEnd(document);
});

test("dragging a subshell row onto the empty Workspace area creates a workspace around it and enters", async () => {
  const fx = rig();
  const { router, container } = await mount(fx);
  // The reworded copy teaches the affordance, so it reads like the gesture
  // the section now takes.
  expect(await screen.findByText("Select a workspace or drag a subshell here to get started.")).toBeTruthy();
  const zone = zoneOf(container);
  expect(zone).toBeTruthy();
  const row = await screen.findByRole("link", { name: /Loose pane/ });
  const dt = transfer("s1");
  fireEvent.dragStart(row, { dataTransfer: dt });
  fireEvent.dragOver(zone as HTMLElement, { dataTransfer: dt });
  // The highlight belongs to the pointer-over state: the drag is also armed
  // (the row's dragstart bubbles to the document), and over the zone the
  // solid-primary ring wins over the quiet dashed one.
  expect(zone?.classList.contains("border-solid")).toBe(true);
  expect(zone?.classList.contains("border-primary")).toBe(true);
  expect(zone?.classList.contains("border-dashed")).toBe(false);
  expect(within(zone as HTMLElement).getByRole("status").textContent).toBe("Drop to create a workspace");
  fireEvent.drop(zone as HTMLElement, { dataTransfer: dt });
  // The same create-with-pane shape the split and the click-a-row filing
  // use, named after the pane: one server path for "a workspace starts here".
  await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces/w9"));
  expect(fx.posts).toHaveLength(1);
  expect(fx.posts[0]?.body).toEqual({ name: "Loose pane", subshellId: "s1" });
});

test("a transfer without the subshell MIME never arms the hint and files nothing", async () => {
  const fx = rig();
  const { router, container } = await mount(fx);
  const zone = zoneOf(container);
  expect(zone).toBeTruthy();
  const dt = transfer("s1", "text/plain");
  fireEvent.dragOver(zone as HTMLElement, { dataTransfer: dt });
  // The MIME gate is the whole safety story (xterm's file drops and
  // dockview's tab drags cross this section too): even a payload whose
  // value reads like an id stays invisible to the zone.
  expect(within(zone as HTMLElement).queryByRole("status") === null).toBe(true);
  fireEvent.drop(zone as HTMLElement, { dataTransfer: dt });
  await new Promise((r) => setTimeout(r, 20));
  expect(fx.posts).toHaveLength(0);
  expect(router.state.location.pathname).toBe("/");
});

test("a second drop while the create is in flight is inert", async () => {
  const fx = rig();
  fx.mode = "hold";
  const { router, container } = await mount(fx);
  const zone = zoneOf(container) as HTMLElement;
  const row = await screen.findByRole("link", { name: /Loose pane/ });
  const dt = transfer("s1");
  fireEvent.dragStart(row, { dataTransfer: dt });
  fireEvent.dragOver(zone, { dataTransfer: dt });
  fireEvent.drop(zone, { dataTransfer: dt });
  // A held POST means a second release of the same row lands while the
  // first create is still in flight: it must open nothing and POST nothing.
  fireEvent.dragOver(zone, { dataTransfer: dt });
  fireEvent.drop(zone, { dataTransfer: dt });
  await act(async () => {
    fx.release();
    await Promise.resolve();
  });
  await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces/w9"));
  expect(fx.posts).toHaveLength(1);
});

test("a failed create surfaces inline with Retry instead of swallowing the drop", async () => {
  const fx = rig();
  fx.mode = "fail";
  const { router, container } = await mount(fx);
  const zone = zoneOf(container) as HTMLElement;
  const dt = transfer("s1");
  fireEvent.dragOver(zone, { dataTransfer: dt });
  fireEvent.drop(zone, { dataTransfer: dt });
  // A failed create keeps its own words on screen, with a retry, instead of
  // the section quietly going back to the empty copy.
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Workspace create exploded");
  expect(router.state.location.pathname).toBe("/");
  fx.mode = "ok";
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fx.posts).toHaveLength(2));
  await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces/w9"));
});

test("a dragend with no dragleave still strips the hover overlay", async () => {
  const fx = rig();
  const { container } = await mount(fx);
  await screen.findByText("Select a workspace or drag a subshell here to get started.");
  const zone = zoneOf(container) as HTMLElement;
  const dt = transfer("s1");
  fireEvent.dragStart(document, { dataTransfer: dt });
  fireEvent.dragOver(zone, { dataTransfer: dt });
  // The pointer-over state: solid primary over the dashed one.
  expect(zone.classList.contains("border-solid")).toBe(true);
  // A drag cancelled with ESC, or one whose source row unmounted, can end on
  // dragend WITHOUT a dragleave. The rail never unmounts to clean up after
  // it, so the shared dragend must strip the hover state too.
  fireEvent.dragEnd(document);
  expect(zone.className.includes("border")).toBe(false);
  expect(within(zone).queryByRole("status") === null).toBe(true);
});

test("a hover hint does not survive the zone leaving and the empty list coming back", async () => {
  const fx = rig();
  const { client, container } = await mount(fx);
  await screen.findByText("Select a workspace or drag a subshell here to get started.");
  const zone = zoneOf(container) as HTMLElement;
  const dt = transfer("s1");
  fireEvent.dragStart(document, { dataTransfer: dt });
  fireEvent.dragOver(zone, { dataTransfer: dt });
  // The pointer-over state: solid primary over the dashed one.
  expect(zone.classList.contains("border-solid")).toBe(true);
  // A workspace arrives from elsewhere WHILE the hover stands: the zone
  // unmounts and the effect's cleanup detaches the document listeners, so
  // this gesture never reports its own end. No dragend, no dragleave: only
  // the list changing, and that flip itself must drop the hover state.
  fx.workspaces.push({
    id: "w1",
    name: "Elsewhere",
    subshellCount: 1,
    updatedAt: "2026-10-20",
    panes: [],
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
  });
  await waitFor(() => expect(zoneOf(container) === null).toBe(true));
  // Then the last workspace goes and the zone returns: it must wear the
  // clean rest state, not a solid ring and an overlay with no drag in
  // flight (the shows-nothing-at-rest assertion above).
  fx.workspaces.length = 0;
  await act(async () => {
    await client.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
  });
  await waitFor(() => expect(zoneOf(container) !== null).toBe(true));
  const restZone = zoneOf(container) as HTMLElement;
  expect(restZone.className.includes("border")).toBe(false);
  expect(restZone.className.includes("rounded")).toBe(false);
  expect(within(restZone).queryByRole("status") === null).toBe(true);
});

test("a stale failure banner does not survive the zone leaving and coming back", async () => {
  const fx = rig();
  fx.mode = "fail";
  const { client, container } = await mount(fx);
  const zone = zoneOf(container) as HTMLElement;
  const dt = transfer("s1");
  fireEvent.dragOver(zone, { dataTransfer: dt });
  fireEvent.drop(zone, { dataTransfer: dt });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Workspace create exploded");
  // A workspace arrives from elsewhere: the zero state ends and the create
  // zone unmounts, taking the banner and its Retry payload with it.
  fx.workspaces.push({
    id: "w1",
    name: "Elsewhere",
    subshellCount: 1,
    updatedAt: "2026-10-20",
    panes: [],
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
  });
  await waitFor(() => expect(zoneOf(container) === null).toBe(true));
  // Then the last workspace goes and the zone returns with the empty state:
  // the old failure must not resurrect with a Retry wired to nothing.
  fx.workspaces.length = 0;
  await act(async () => {
    await client.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
  });
  await waitFor(() => expect(zoneOf(container) !== null).toBe(true));
  expect(screen.queryByRole("alert") === null).toBe(true);
});

test("the iPad pointer session dresses the create zone and files the pane on release", async () => {
  // The transport iPadOS needs: no dragstart ever comes from a trackpad, so
  // the ring and the create-with-pane POST must ride the pointer session
  // alone (lib/subshell-pointer-drag).
  const fx = rig();
  const { container } = await mount(fx);
  await screen.findByText("Select a workspace or drag a subshell here to get started.");
  const zone = zoneOf(container) as HTMLElement;
  // happy-dom lays out nothing: hand the session's hit-test a rect.
  zone.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }) as DOMRect;
  act(() => {
    beginPointerSubshellDrag({
      subshellId: "s1",
      pointerType: "mouse",
      button: 0,
      clientX: 10,
      clientY: 10,
      sourceElement: document.createElement("div"),
    });
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 150, clientY: 150 }));
  });
  // Promoted over the zone: the solid hover dressing and the label, exactly
  // what the HTML5 dragover paints.
  expect(zone.className.includes("border-primary")).toBe(true);
  expect(within(zone).getByRole("status").textContent).toBe("Drop to create a workspace");
  await act(async () => {
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 150, clientY: 150 }));
  });
  // The same create-with-pane POST the HTML5 drop makes, same body.
  await waitFor(() => expect(fx.posts.length).toBe(1));
  expect(fx.posts[0]?.body).toEqual({ name: "Loose pane", subshellId: "s1" });
});

test("the drop zone is absent once the instance has a workspace", async () => {
  const fx = rig([
    {
      id: "w1",
      name: "Board",
      subshellCount: 1,
      updatedAt: "2026-10-20",
      panes: [{ id: "p1", subshellId: "s1", subshellName: "Loose pane", workingDir: "/project" }],
    },
  ]);
  const { container } = await mount(fx);
  // With a workspace, the section's own drop areas (add/remove) own drags;
  // a create-around drop belongs to the zero-workspace state only.
  expect(await screen.findByText("Board")).toBeTruthy();
  expect(zoneOf(container) === null).toBe(true);
  expect(screen.queryByText("Select a workspace or drag a subshell here to get started.") === null).toBe(true);
});
