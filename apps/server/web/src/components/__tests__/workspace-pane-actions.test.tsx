import { afterEach, expect, it } from "bun:test";
import type { ViewersState } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { PaneFocusHeader } from "@/components/pane-focus-header";
import { usePublishPaneDevices } from "@/hooks/use-pane-devices";
import { usePaneDiagnostics } from "@/hooks/use-pane-diagnostics";
import { paneDiagnosticsIds, resetPaneDiagnosticsPrefForTests } from "@/lib/pane-diagnostics-pref";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { resetWorkspaceFocusForTests, setWorkspaceFocusedId } from "@/lib/workspace-focus";
import type { SubshellView } from "@/types/subshell";
import type { WorkspacePaneRow } from "@/types/workspace";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  resetWorkspaceFocusForTests();
  globalThis.fetch = originalFetch;
});

function row(id: string, access: SubshellView["access"] = "owner", name = id): SubshellView {
  return {
    id,
    // `name` defaults to the id, and the Diagnostics case below overrides it: a
    // fixture where the two are the same string cannot tell an id-keyed
    // preference from a name-keyed one.
    name,
    nameLocked: false,
    presetId: null,
    harnessId: "terminal",
    workingDir: "/tmp",
    status: "running",
    alive: true,
    access,
    ssh: false,
    nodeOffline: false,
    notify: false,
    activity: "idle",
    createdAt: "2026-10-01",
    endedAt: null,
    lastOutputAt: null,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    waitingSince: null,
    unseenPush: false,
  };
}

async function header(rows: SubshellView[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(SUBSHELLS_QUERY_KEY, rows);
  globalThis.fetch = (async (input: string | URL | Request) =>
    new Response(JSON.stringify(String(input).includes("/api/prompts") ? { own: [], shared: [] } : []), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const panes = rows.map((r) => ({ id: `pane-${r.id}`, subshellId: r.id })) as WorkspacePaneRow[];
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <PaneFocusHeader fallbackName="My workspace" panes={panes} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

it("offers Insert prompt for the focused pane and retires its dialog when focus changes", async () => {
  setWorkspaceFocusedId("first");
  await header([row("first"), row("second")]);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for first" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Insert prompt…" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  act(() => setWorkspaceFocusedId("second"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByRole("button", { name: "Actions for second" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Actions for first" })).toBeNull();
});

it("offers the Diagnostics HUD toggle for the focused pane, keyed by id", async () => {
  // The workspace header stands over the focused pane's dock terminal, so
  // the Wave C toggle belongs here too, reading and writing the same
  // per-device preference the terminal opens its HUD from.
  //
  // The pane is called something other than its id on purpose. The menu's own
  // label is the NAME ("Actions for Dev pane") while the preference it writes is
  // keyed by id, so with both halves of the fixture sharing one string a
  // name-keyed implementation would pass this test; a rename would then close
  // the HUD the person just opened, which is the thing the preference's
  // id-keying exists to prevent.
  localStorage.removeItem("subshell.paneDiagnostics");
  setWorkspaceFocusedId("sub-9");
  await header([row("sub-9", "owner", "Dev pane")]);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Dev pane" }));
  const item = await screen.findByRole("menuitem", { name: "Diagnostics" });
  expect(paneDiagnosticsIds()).toEqual([]);
  fireEvent.click(item);
  expect(paneDiagnosticsIds()).toEqual(["sub-9"]);
});

it("still switches the Diagnostics HUD on when the device refuses to store it", () => {
  // Private browsing and a full quota both make the write throw, and the
  // preference keeps the choice for this page load on purpose. The hook used to
  // read the preference back after writing it, so a refused write meant the
  // menu item never checked, the HUD never appeared, and the click was lost
  // with nothing on screen to say why.
  //
  // `localStorage.setItem = ...` would not simulate that here: happy-dom's
  // Storage is a proxy, so the assignment lands as a stored key and the real
  // write still happens. Swapping the global does block it, and the descriptor
  // goes back in `finally`: happy-dom's localStorage is process-wide, and a
  // leaking thrower would poison every later test in this worker.
  localStorage.removeItem("subshell.paneDiagnostics");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const real = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => real.getItem(key),
      removeItem: (key: string) => real.removeItem(key),
      setItem: () => {
        throw new Error("quota");
      },
    } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">,
    configurable: true,
    writable: true,
  });
  try {
    // Two instances, the way the workspace really has them: the header's menu
    // and the dock terminal below it each hold their own hook. One binding to
    // the attempted set while the other re-reads an unwritable store is the
    // divergence this pins shut, so the assertion covers the pair, not the
    // toggle that made it.
    const { result: header } = renderHook(() => usePaneDiagnostics("first"));
    const { result: terminal } = renderHook(() => usePaneDiagnostics("first"));
    act(() => header.current[1]());
    expect(header.current[0]).toBe(true);
    expect(terminal.current[0]).toBe(true);
    // Only the first press is asserted: with the write refused the set never
    // accumulates anywhere, so a second press reads back empty and turns it on
    // again. That is the preference layer's behavior for every caller (the
    // subshell page reads the same way), not something this hook can fix.
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    // Same module, shared worker: the refused write left a page-load memory
    // behind that the next file would otherwise read as its own truth.
    resetPaneDiagnosticsPrefForTests();
  }
});

it("preserves read-only gates in a saved workspace", async () => {
  setWorkspaceFocusedId("viewer");
  await header([row("viewer", "view")]);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for viewer" }));
  expect(screen.queryByRole("menuitem", { name: "Insert prompt…" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
});

it("does not expose actions for a stale focus outside this workspace", async () => {
  setWorkspaceFocusedId("other-workspace");
  await header([row("first")]);
  // The header rendered (its own name), and a focus pointing at a pane that
  // is not in this workspace hoists no actions — the set constrains the
  // global focus, not just the ring.
  expect(await screen.findByText("My workspace")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
});

it("wears the focused pane's subshell header — dot, editable name, working dir", async () => {
  setWorkspaceFocusedId("first");
  await header([row("first"), row("second")]);
  // The bar shows the PANE's identity, not the workspace's: the name edits
  // as a subshell (spec 2026-10-17; the workspace name lives in the rail menu).
  const title = await screen.findByRole("button", { name: "Rename subshell" });
  expect(title.textContent).toBe("first");
  expect(screen.queryByRole("button", { name: "Rename workspace" })).toBeNull();
});

it("shows the workspace's plain name only while no pane has focus", async () => {
  await header([]);
  expect(await screen.findByText("My workspace")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Rename subshell" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Rename workspace" })).toBeNull();
});

it("keeps device controls in the header and targets the newly focused pane", async () => {
  const state: ViewersState = {
    you: "me",
    viewers: ["me", "phone"].map((id) => ({
      id,
      label: id,
      capacity: { cols: 80, rows: 24 },
      since: "2026-10-21",
      canInput: true,
      hidden: false,
    })),
    sizing: { mode: "auto", pinnedViewerId: null },
  };
  const calls: string[] = [];
  const first = () => {
    calls.push("first");
  };
  const second = () => {
    calls.push("second");
  };
  const publisher = renderHook(() => {
    usePublishPaneDevices("pane-first", state, first);
    usePublishPaneDevices("pane-second", state, second);
  });
  setWorkspaceFocusedId("first");
  await header([row("first"), row("second")]);
  const trigger = await screen.findByRole("button", { name: /devices watching/i });
  expect(trigger.closest("header")).not.toBeNull();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await screen.findAllByRole("menuitem");
  act(() => setWorkspaceFocusedId("second"));
  await waitFor(() => expect(screen.queryByRole("menu") === null).toBe(true));
  fireEvent.keyDown(screen.getByRole("button", { name: /devices watching/i }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /me.*this device/i }));
  expect(calls).toEqual(["second"]);
  publisher.unmount();
  expect(screen.queryByRole("button", { name: /devices watching/i }) === null).toBe(true);
});
