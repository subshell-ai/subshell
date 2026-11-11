import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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
                  sshWideForwards: false,
                  maintenance: false,
                  harnesses: [],
                  allowedDirs: [],
                },
              ],
            }
          : path === "/api/ssh/recent-destinations"
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
                sshWideForwards: false,
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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function launchSsh() {
  const newMode = screen.queryByRole("button", { name: "New subshell" });
  if (newMode) fireEvent.click(newMode);
  fireEvent.click(await screen.findByRole("button", { name: "SSH terminal" }));
  await settle();
  const field = await screen.findByLabelText("SSH destination");
  fireEvent.change(field, { target: { value: "deploy@example.com:2222" } });
  await settle();
  const start = screen.getByRole("button", { name: "Start SSH subshell" });
  await waitFor(() => expect(start.getAttribute("aria-disabled")).not.toBe("true"));
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
  await waitFor(() => expect(adds).toEqual([["ssh-new", "within"]]));
  const start = screen.getByRole("button", { name: "Starting SSH subshell…" });
  expect(start.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(start);
  expect(calls.filter((c) => c.path === "/api/ssh/launch")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Existing subshell" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Split down" })).toBeNull();
  await act(async () => {
    finish();
  });
  await waitFor(() => expect(closed).toBe(true));
});

it("a created SSH subshell that fails to attach drops to a Close-only state", async () => {
  api();
  await mount(() => (
    <AddSubshellDialog
      open
      onOpenChange={() => {}}
      onAdd={async () => {
        throw new Error("add refused");
      }}
    />
  ));
  await launchSsh();
  expect(await screen.findByText(/couldn't be added \(add refused\)/)).toBeTruthy();
  // No launch controls: pressing Start again would create a second subshell.
  expect(screen.getAllByRole("button", { name: "Close" }).some((button) => button.textContent === "Close")).toBe(true);
  expect(screen.queryByRole("button", { name: "Start SSH subshell" })).toBeNull();
  expect(screen.queryByRole("button", { name: "SSH terminal" })).toBeNull();
});
