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
  forwards: [],
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
        forwards: [],
      },
    },
  ]);
});

it("saves a declared port forward alongside the connection choices", async () => {
  const { writes, closed } = await setup();
  await waitFor(() => expect(disabled()).toBe(false));
  fireEvent.change(screen.getByLabelText(/Local port/), { target: { value: "5432" } });
  fireEvent.change(screen.getByLabelText(/Target host/), { target: { value: "db.internal" } });
  fireEvent.change(screen.getByLabelText(/Target port/), { target: { value: "5432" } });
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Add port forward" }) as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
  await waitFor(() => expect(screen.getByText("loopback:5432")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  await waitFor(() => expect(closed()).toBe(true));
  expect(writes[0]?.body.forwards).toEqual([
    { kind: "local", listenPort: 5432, bindHost: null, targetHost: "db.internal", targetPort: 5432 },
  ]);
});

it("a half-typed forward never reaches the preset: Add stays off and Save is not held", async () => {
  const { writes, closed } = await setup();
  await waitFor(() => expect(disabled()).toBe(false));
  fireEvent.change(screen.getByLabelText(/Local port/), { target: { value: "5432" } });
  fireEvent.change(screen.getByLabelText(/Target port/), { target: { value: "5432" } });
  // The incomplete editor row gates its own Add button, not the Save button.
  // Disabled state rides aria-disabled (the node-admin Button explains itself
  // while focusable), so check both spellings.
  await waitFor(() => {
    const b = screen.getByRole("button", { name: "Add port forward" }) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute("aria-disabled") === "true").toBe(true);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  await waitFor(() => expect(closed()).toBe(true));
  expect(writes[0]?.body.forwards).toEqual([]);
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

it("shows name and destination problems on blur and blocks saving until corrected", async () => {
  const { writes } = await setup();
  const name = screen.getByLabelText("Name");
  fireEvent.focus(name);
  fireEvent.change(name, { target: { value: "   " } });
  expect(screen.queryByText("Enter a preset name.") === null).toBe(true);
  fireEvent.blur(name);
  expect(screen.getByText("Enter a preset name.")).toBeDefined();
  expect(name.getAttribute("aria-invalid")).toBe("true");
  await waitFor(() => expect(disabled()).toBe(true));
  fireEvent.focus(name);
  expect(screen.queryByText("Enter a preset name.") === null).toBe(true);
  fireEvent.change(name, { target: { value: "Valid name" } });
  fireEvent.blur(name);
  const destination = screen.getByLabelText("SSH destination");
  fireEvent.focus(destination);
  fireEvent.change(destination, { target: { value: "user@host:70000" } });
  expect(screen.queryByText("Enter a port between 1 and 65535.") === null).toBe(true);
  fireEvent.blur(destination);
  expect(screen.getByText("Enter a port between 1 and 65535.")).toBeDefined();
  expect(destination.getAttribute("aria-invalid")).toBe("true");
  await waitFor(() => expect(disabled()).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  expect(writes).toHaveLength(0);
  fireEvent.change(destination, { target: { value: "user@host:22" } });
  await waitFor(() => expect(disabled()).toBe(false));
});

it("renders a resolve refusal as its cause and remedy, not the raw 422 body", async () => {
  await setup();
  fireEvent.blur(screen.getByLabelText("Name"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT")
      return Response.json(
        { outcome: { accepted: false, code: "unsupported_setting", settings: ["ProxyCommand"] } },
        { status: 422 },
      );
    return previousFetch(input as RequestInfo, init);
  }) as typeof fetch;
  await waitFor(() => expect(disabled()).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  const cause = await screen.findByText(/uses settings Subshell doesn't support: ProxyCommand/);
  expect(cause.textContent ?? "").toContain("connecting machine");
  expect(document.body.textContent?.includes("API 422") ?? false).toBe(false);
});

it("places a duplicate-name refusal beside the name and clears it when edited", async () => {
  await setup();
  fireEvent.blur(screen.getByLabelText("Name"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT")
      return Response.json(
        { code: "duplicate", message: "You already have an SSH preset with that name" },
        { status: 409 },
      );
    return previousFetch(input as RequestInfo, init);
  }) as typeof fetch;
  await waitFor(() => expect(disabled()).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  const message = await screen.findByText("You already have an SSH preset with that name. Choose another name.");
  const name = screen.getByLabelText("Name");
  expect(name.getAttribute("aria-describedby")).toBe(message.id);
  fireEvent.change(name, { target: { value: "Different name" } });
  await waitFor(() => expect(screen.queryByText(message.textContent ?? "") === null).toBe(true));
});
