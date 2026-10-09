import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NewWorkspaceDialog } from "@/components/sidebar/new-workspace-dialog";
import { AddSubshellDialog } from "@/components/subshell-picker/add-subshell-dialog";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function api() {
  const calls: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "POST") calls.push({ path, body });
    const value =
      path === "/api/files/recent"
        ? { paths: [], home: null }
        : path === "/api/nodes"
          ? {
              nodes: [
                {
                  id: "local",
                  name: "Server",
                  kind: "local",
                  status: "online",
                  canLaunch: true,
                  canManage: true,
                  access: "owner",
                  sshEnabled: true,
                  maintenance: false,
                  harnesses: [],
                  allowedDirs: [],
                },
              ],
            }
          : path === "/api/ssh/saved-hosts"
            ? { saved: [], recent: [], defaultNodeId: "local" }
            : path === "/api/ssh/aliases"
              ? { aliases: [] }
              : path === "/api/ssh/launch"
                ? { subshell: { id: "ssh-new" } }
                : path === "/api/subshells" || path === "/api/presets"
                  ? []
                  : path === "/api/workspaces"
                    ? init?.method === "POST"
                      ? { id: "workspace-new" }
                      : []
                    : path.endsWith("/panes")
                      ? { id: "pane-new" }
                      : {};
    if (path === "/api/ssh/readiness")
      return new Response(
        JSON.stringify({
          machines: [
            {
              node: {
                id: "local",
                name: "Server",
                kind: "local",
                sshEnabled: true,
                canLaunch: true,
                canManage: true,
                status: "online",
                harnesses: [],
              },
              canConnect: true,
              canConfigure: true,
              blockers: [],
            },
          ],
        }),
      );
    return new Response(JSON.stringify(value));
  }) as typeof fetch;
  return calls;
}

async function mount(component: () => ReactNode) {
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component }),
      createRoute({ getParentRoute: () => root, path: "/workspaces/$id", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function launchSsh() {
  fireEvent.click(await screen.findByRole("button", { name: "New subshell" }));
  fireEvent.click(await screen.findByRole("button", { name: "SSH terminal" }));
  const field = await screen.findByLabelText("SSH destination");
  fireEvent.change(field, { target: { value: "deploy@example.com:2222" } });
  const start = screen.getByRole("button", { name: "Start SSH subshell" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
}

it("adds the SSH result to the current split and blocks duplicate launches while attaching", async () => {
  const calls = api();
  const adds: string[][] = [];
  let finish!: () => void;
  let closed = false;
  await mount(() => (
    <AddSubshellDialog
      open
      excludeSubshellIds={[]}
      onOpenChange={() => {
        closed = true;
      }}
      onAdd={async (id, direction) => {
        adds.push([id, direction]);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }}
    />
  ));
  await launchSsh();
  await waitFor(() => expect(adds).toEqual([["ssh-new", "right"]]));
  const start = screen.getByRole("button", { name: "Connecting…" });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(start);
  expect(calls.filter((c) => c.path === "/api/ssh/launch")).toHaveLength(1);
  finish();
  await waitFor(() => expect(closed).toBe(true));
});

it("keeps a newly launched SSH subshell selected when creating a workspace", async () => {
  const calls = api();
  await mount(() => <NewWorkspaceDialog open onOpenChange={() => {}} />);
  await launchSsh();
  await screen.findByText("1 subshell to add");
  fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
  await waitFor(() =>
    expect(calls).toContainEqual({ path: "/api/workspaces/workspace-new/panes", body: { subshellId: "ssh-new" } }),
  );
});
