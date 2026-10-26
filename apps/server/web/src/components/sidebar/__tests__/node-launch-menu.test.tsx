import { afterEach, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { QuickAddProvider } from "@/components/quick-add";
import { NodeLaunchMenu } from "@/components/sidebar/node-launch-menu";
import { setCurrentWorkspace } from "@/lib/current-workspace";
import { setFetchRouter } from "@/test-setup";

const machine = (id: string, overrides: Partial<Node> = {}) =>
  ({
    id,
    name: id === "local" ? "Server" : "Laptop",
    kind: id === "local" ? "local" : "agent",
    status: "online",
    canLaunch: true,
    maintenance: false,
    access: "owner",
    harnesses: [
      { harnessId: "terminal", installed: true },
      { harnessId: "claude-code", installed: true },
    ],
    allowedDirs: [],
    ...overrides,
  }) as Node;

afterEach(() => {
  cleanup();
  setCurrentWorkspace(null);
});

async function setup({
  node = machine("remote"),
  paths = [{ path: "/project", label: null }],
  lockdown = false,
}: {
  node?: Node;
  paths?: { path: string; label: null }[];
  lockdown?: boolean;
} = {}) {
  const creates: Record<string, unknown>[] = [];
  const recentNodes: (string | null)[] = [];
  setCurrentWorkspace("workspace");
  setFetchRouter(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/files/recent") {
      recentNodes.push(url.searchParams.get("node"));
      return Response.json({ paths, home: `/${url.searchParams.get("node")}/home` });
    }
    if (url.pathname === "/api/subshells" && init?.method === "POST") {
      creates.push(JSON.parse(String(init.body)));
      return Response.json({ id: "created" });
    }
    if (url.pathname === "/api/subshells")
      return Response.json([
        {
          id: "previous",
          nodeId: "remote",
          harnessId: "claude-code",
          workingDir: "/remote/previous",
          createdAt: "2026-10-25T00:00:00Z",
        },
      ]);
    if (url.pathname === "/api/nodes") return Response.json({ nodes: [machine("local"), machine("remote")] });
    if (url.pathname === "/api/plugins")
      return Response.json({
        plugins: [
          { id: "terminal", name: "Terminal", type: "terminal", installed: true, enabled: true },
          { id: "claude-code", name: "Claude Code", type: "agent-harness", installed: true, enabled: true },
        ],
      });
    if (url.pathname === "/api/settings/public") return Response.json({ lockdown });
    return Response.json([]);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QuickAddProvider>
        <NodeLaunchMenu node={node} />
      </QuickAddProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/workspaces/$id", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return { creates, recentNodes, router };
}

it("starts a terminal immediately on the named node and files it into the current workspace", async () => {
  const { creates, recentNodes, router } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "New subshell on Laptop" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "New terminal" }));
  await waitFor(() => expect(creates).toHaveLength(1));
  expect(creates[0]).toMatchObject({
    nodeId: "remote",
    harnessId: "terminal",
    workingDir: "/project",
    workspaceId: "workspace",
  });
  expect(creates[0].presetId).toBeUndefined();
  expect(creates[0].prompt).toBeUndefined();
  expect(recentNodes).toEqual(["remote"]);
  await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces/workspace"));
});

it("uses the selected node's home when it has no recent directories", async () => {
  const { creates } = await setup({ paths: [] });
  fireEvent.click(screen.getByRole("button", { name: "New subshell on Laptop" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "New terminal" }));
  await waitFor(() => expect(creates[0]?.workingDir).toBe("/remote/home"));
});

it("keeps an explicitly selected server instead of copying the last launch's remote node", async () => {
  const { creates } = await setup({ node: machine("local"), paths: [] });
  fireEvent.click(screen.getByRole("button", { name: "New subshell on Server" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "New subshell" }));
  await screen.findByRole("dialog");
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "Node" }) as HTMLInputElement).value).toContain("Server"),
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe("/local/home"),
  );
  expect(creates).toHaveLength(0);
});

for (const [label, overrides] of [
  ["offline", { status: "offline" }],
  ["maintenance", { maintenance: true, canLaunch: false }],
  ["permission", { canLaunch: false }],
] as const) {
  it(`blocks launch when the machine is unavailable: ${label}`, async () => {
    const { creates } = await setup({ node: machine("remote", overrides) });
    const button = screen.getByRole("button", { name: "New subshell on Laptop" });
    expect(button.getAttribute("aria-disabled") === "true" || (button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(creates).toHaveLength(0);
  });
}

it("blocks launches during lockdown", async () => {
  await setup({ lockdown: true });
  const button = screen.getByRole("button", { name: "New subshell on Laptop" });
  expect(button.getAttribute("aria-disabled") === "true" || (button as HTMLButtonElement).disabled).toBe(true);
});

it("keeps the directory default when reopening a node launch with cached paths in Strict Mode", async () => {
  await setup({ node: machine("local"), paths: [] });
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(screen.getByRole("button", { name: "New subshell on Server" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New subshell" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe("/local/home"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
});
