import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PaneFocusHeader } from "@/components/pane-focus-header";
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

function row(id: string, access: SubshellView["access"] = "owner"): SubshellView {
  return {
    id,
    name: id,
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
