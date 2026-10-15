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
import { SshPresetEditor } from "@/components/presets/ssh-preset-editor";
import type { SshPreset } from "@/types/preset";

function disabled() {
  const button = screen.getByRole("button", { name: "Save preset" }) as HTMLButtonElement;
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}
const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});
const preset: SshPreset = {
  kind: "ssh",
  id: "p",
  name: "My build",
  description: null,
  destination: "user@build:22",
  alias: "build",
  resolutionAlias: "private-build",
  nodeId: "desk",
  authentication: "local-key",
  keyHome: null,
  fingerprints: [],
  createdAt: "t",
  updatedAt: "t",
};
async function setup(online = true) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let closed = false;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      return Response.json({ ...preset, ...body });
    }
    if (path === "/api/ssh/readiness")
      return Response.json({
        machines: [
          {
            node: { id: "desk", name: "Desktop", kind: "agent", canLaunch: true, sshEnabled: true },
            canConnect: online,
            blockers: [],
            canConfigure: true,
          },
        ],
      });
    if (path === "/api/ssh/recent-destinations") return Response.json({ recent: [], defaultNodeId: null });
    if (path === "/api/ssh/aliases") return Response.json({ aliases: [] });
    return Response.json([]);
  }) as typeof fetch;
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <SshPresetEditor
        preset={preset}
        onClose={() => {
          closed = true;
        }}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("dialog", { name: "Edit SSH preset" });
  return { writes, closed: () => closed };
}
it("saves the local-key radio choice without requiring a file or approval", async () => {
  const { writes, closed } = await setup();
  expect(screen.getByRole("radio", { name: "Use a key from my machine" }).getAttribute("aria-checked")).toBe("true");
  const localKeyChoice = screen.getByRole("radio", { name: "Use a key from my machine" });
  expect(document.getElementById(localKeyChoice.getAttribute("aria-describedby") ?? "")?.textContent).toContain(
    "Choose a key from your machine when creating a new SSH subshell",
  );
  expect(screen.queryByRole("button", { name: "Choose key…" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "I trust this website and its operator" })).toBeNull();
  await waitFor(() => expect(disabled()).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  await waitFor(() => expect(closed()).toBe(true));
  expect(writes).toEqual([
    {
      path: "/api/presets/p",
      body: {
        name: "My build",
        description: null,
        nodeId: "desk",
        destination: "user@build:22",
        resolutionAlias: "private-build",
        expectedDestination: "user@build:22",
        alias: "build",
        authentication: "local-key",
        keyHome: null,
        fingerprints: [],
      },
    },
  ]);
});
it("allows unrelated edits while the saved connecting node is offline", async () => {
  const { writes } = await setup(false);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
  await waitFor(() => expect(disabled()).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  await waitFor(() => expect(writes[0]?.body.name).toBe("Renamed"));
});
it("requires a name and refuses a changed destination while the node is offline", async () => {
  await setup(false);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
  await waitFor(() => expect(disabled()).toBe(true));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
  fireEvent.change(screen.getByLabelText("SSH destination"), { target: { value: "other:22" } });
  await waitFor(() => expect(disabled()).toBe(true));
});

it("releases the saved destination guard and alias on a deliberate destination edit", async () => {
  const { writes } = await setup();
  fireEvent.change(screen.getByLabelText("SSH destination"), { target: { value: "new-build" } });
  await waitFor(() => expect(disabled()).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body.destination).toBe("new-build");
  expect(writes[0]?.body.expectedDestination).toBeUndefined();
  expect(writes[0]?.body.resolutionAlias).toBeUndefined();
});
