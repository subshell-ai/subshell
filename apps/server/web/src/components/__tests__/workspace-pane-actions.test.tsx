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
import { WorkspaceHeader } from "@/components/workspace-header";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { resetWorkspaceFocusForTests, setWorkspaceFocusedId } from "@/lib/workspace-focus";
import type { SubshellView } from "@/types/subshell";
import type { WorkspacePaneRow, WorkspaceRow } from "@/types/workspace";

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

async function header(rows: SubshellView[], draft = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(SUBSHELLS_QUERY_KEY, rows);
  globalThis.fetch = (async (input: string | URL | Request) =>
    new Response(JSON.stringify(String(input).includes("/api/prompts") ? { own: [], shared: [] } : []), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const workspace: WorkspaceRow = {
    id: "w1",
    name: "My workspace",
    draft,
    layout: null,
    subshellCount: rows.length,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
  };
  const panes = rows.map((r) => ({ id: `pane-${r.id}`, subshellId: r.id })) as WorkspacePaneRow[];
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <WorkspaceHeader workspace={workspace} panes={panes} />,
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

it("offers Inject prompt for the focused pane and retires its dialog when focus changes", async () => {
  setWorkspaceFocusedId("first");
  await header([row("first"), row("second")]);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for first" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Inject prompt..." }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  act(() => setWorkspaceFocusedId("second"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByRole("button", { name: "Actions for second" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Actions for first" })).toBeNull();
});

it("preserves read-only gates in a saved workspace", async () => {
  setWorkspaceFocusedId("viewer");
  await header([row("viewer", "view")], false);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for viewer" }));
  expect(screen.queryByRole("menuitem", { name: "Inject prompt..." })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
});

it("does not expose actions for a stale focus outside this workspace", async () => {
  setWorkspaceFocusedId("other-workspace");
  await header([row("first")]);
  expect(await screen.findByText("Unsaved workspace")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
});
