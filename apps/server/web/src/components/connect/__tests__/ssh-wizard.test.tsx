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
import { ConnectPanel } from "@/components/connect/connect-panel";
import type { SshInitialChoices } from "@/components/connect/ssh-session-draft";
import { SshWizardDialog } from "@/components/connect/ssh-wizard-dialog";
import type { SshMachineReadiness } from "@/lib/ssh";

const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function machine(id: string, ready = true, configure = true, kind: "agent" | "local" = "agent"): SshMachineReadiness {
  const node = {
    id,
    name: id === "local" ? "Named server" : id,
    kind,
    os: null,
    arch: null,
    status: "online",
    canLaunch: true,
    canManage: configure,
    access: configure ? "owner" : "view",
    sshEnabled: ready,
    maintenance: false,
    held: null,
    harnesses: [],
  } as unknown as Node;
  return {
    node,
    canConnect: ready,
    canConfigure: configure,
    blockers: ready ? [] : [{ code: "SSH_GATE_OFF", message: "SSH is off on this machine." }],
  };
}
async function setup({
  initial,
  machines = [machine("desk"), machine("keys")],
  readyError = false,
  enrollmentAllowed = true,
  start = true,
  settingsEntry = false,
  onCreated,
}: {
  initial?: SshInitialChoices;
  machines?: SshMachineReadiness[];
  readyError?: boolean;
  enrollmentAllowed?: boolean;
  start?: boolean;
  settingsEntry?: boolean;
  onCreated?: (id: string) => Promise<void> | void;
} = {}) {
  const state = {
    machines,
    readyError,
    savedError: false,
    aliasesError: false,
    identities: [{ fingerprint: "SHA256:AAAA", comment: "Work key" }],
    rosterError: false,
    consumedNodeId: null as string | null,
    setupKeyReads: 0,
    enrollmentAllowed,
  };
  const calls: { path: string; method: string; body?: unknown }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    calls.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/api/settings/public")
      return json({
        allowNodeEnrollment: state.enrollmentAllowed,
        viewerIsAdmin: false,
        appBaseUrl: "https://plane.example",
        trustedOrigins: ["https://plane.example", "https://other.example"],
      });
    if (path === "/api/ssh/readiness")
      return state.readyError ? json({ message: "read failed" }, 503) : json({ machines: state.machines });
    if (path === "/api/ssh/saved-hosts")
      return state.savedError
        ? json({ message: "saved read failed" }, 503)
        : json({ saved: [], recent: [], defaultNodeId: null });
    if (path === "/api/ssh/aliases")
      return state.aliasesError
        ? json({ message: "aliases read failed" }, 503)
        : json({ aliases: ["work"], includeCycle: false, truncated: false });
    if (path === "/api/ssh/identities")
      return state.rosterError ? json({ message: "No SSH_AUTH_SOCK" }, 502) : json({ identities: state.identities });
    if (path.endsWith("/ssh-enabled")) {
      state.machines = state.machines.map((m) =>
        path.includes(`/${m.node.id}/`)
          ? {
              ...m,
              node: { ...m.node, sshEnabled: true },
              canConnect: m.node.status === "online",
              blockers:
                m.node.status === "online" ? [] : [{ code: "NODE_OFFLINE", message: "Bring this machine online." }],
            }
          : m,
      );
      return json({ sshEnabled: true });
    }
    if (path === "/api/nodes/setup-keys") {
      if (method === "POST") return json({ id: "my-key", key: "nsk_mine", expiresAt: "2099-01-01" });
      state.setupKeyReads++;
      return json({
        keys: [
          {
            id: "my-key",
            key: "nsk_mine",
            consumedNodeId: state.consumedNodeId,
            usedAt: state.consumedNodeId ? "now" : null,
            expiresAt: "2099-01-01",
          },
        ],
      });
    }
    if (path === "/api/ssh/launch") return json({ subshell: { id: "created-ssh" } }, 201);
    return json({});
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () =>
          settingsEntry ? (
            <SshWizardDialog initial={initial} />
          ) : (
            <ConnectPanel initial={initial} startInWizard={start} onCreated={onCreated ?? (() => {})} />
          ),
      }),
      createRoute({ getParentRoute: () => root, path: "/nodes/$id", component: () => <p>Machine settings</p> }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
  return { state, calls, client };
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function click(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
  await settle();
}
async function next() {
  const button = await screen.findByRole("button", { name: "Continue" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await settle();
}
async function choose(label: string, name: string) {
  const field = screen.getByRole("combobox", { name: label });
  act(() => {
    for (const type of ["pointerdown", "pointerup"])
      field.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }));
    for (const type of ["mousedown", "mouseup", "click"])
      field.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
  // Let the picker finish focusing and restoring its selected label before
  // typing the search, or that opening work can overwrite the query.
  await settle();
  fireEvent.change(field, { target: { value: name } });
  await settle();
  fireEvent.click(await screen.findByRole("option", { name }));
  await settle();
}

async function task(name = "Connect to a destination") {
  fireEvent.click(screen.getByRole("radio", { name }));
  await settle();
  await next();
}
function disabled(name = "Start SSH subshell") {
  return (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
}
it("uses radio task choices and a single connection form", async () => {
  const { calls } = await setup({ initial: { node: "desk", destination: "target" } });
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  await task();
  expect(screen.getByLabelText("SSH destination")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Connect from" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: "Use the connecting node’s keys" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  fireEvent.click(screen.getByLabelText("Remember this destination"));
  await settle();
  await click("Start SSH subshell");
  expect(calls.find((c) => c.path === "/api/ssh/launch")?.body).toEqual({ node: "desk", destination: "target" });
  expect(calls.find((c) => c.path === "/api/ssh/saved-hosts" && c.method === "PUT")?.body).toEqual({
    node: "desk",
    destination: "target",
  });
});
it("enables an owned node inline without launching", async () => {
  const { calls } = await setup({
    initial: { node: "desk", destination: "target" },
    machines: [machine("desk", false)],
  });
  await task();
  expect(disabled()).toBe(true);
  await click("Enable SSH");
  await waitFor(() => expect(disabled()).toBe(false));
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
});
it("shows owner guidance and blocks unauthorized configuration", async () => {
  const { calls } = await setup({
    initial: { node: "shared", destination: "target" },
    machines: [machine("shared", false, false)],
  });
  await task();
  expect(screen.queryByRole("button", { name: "Enable SSH" })).toBeNull();
  expect(screen.getByText(/This machine’s owner can enable SSH/)).toBeTruthy();
  expect(disabled()).toBe(true);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});
it("reveals the remote node picker and explicit keys inline", async () => {
  const named = machine("desk");
  named.node.name = "A very long connecting node name that wraps under the fixed radio label";
  const { calls } = await setup({
    initial: { node: "desk", destination: "target" },
    machines: [named, machine("keys")],
  });
  await task();
  expect(screen.getByText(named.node.name)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Use another node’s keys" }));
  await settle();
  expect(disabled()).toBe(true);
  await choose("Use keys from", "keys");
  expect(screen.getByRole("checkbox", { name: "Work key" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("checkbox", { name: "Work key" }));
  await settle();
  await click("Start SSH subshell");
  expect(calls.find((c) => c.path === "/api/ssh/launch")?.body).toEqual({
    node: "desk",
    destination: "target",
    keyHome: "keys",
    fingerprints: ["SHA256:AAAA"],
  });
});
it("selects remote keys in the connection form without launching", async () => {
  const { calls } = await setup({ initial: { node: "desk", destination: "target" } });
  await task();
  fireEvent.click(screen.getByRole("radio", { name: "Use another node’s keys" }));
  await settle();
  await choose("Use keys from", "keys");
  fireEvent.click(screen.getByRole("checkbox", { name: "Work key" }));
  await settle();
  expect((screen.getByLabelText("SSH destination") as HTMLInputElement).value).toBe("target");
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
});
it("blocks same-node key sources until own keys are explicitly chosen", async () => {
  const { calls } = await setup({
    initial: { node: "keys", keyHome: "keys", destination: "target", fingerprints: ["SHA256:AAAA"] },
  });
  await task();
  expect(screen.getByText(/already selected under Connect from/)).toBeTruthy();
  expect(disabled()).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Use the connecting node’s keys" }));
  await settle();
  await click("Start SSH subshell");
  expect(calls.find((c) => c.path === "/api/ssh/launch")?.body).toEqual({ node: "keys", destination: "target" });
});
it("blocks vanished keys and unavailable SSH agents", async () => {
  const { state } = await setup({
    initial: { node: "desk", keyHome: "keys", destination: "target", fingerprints: ["SHA256:AAAA"] },
  });
  await task();
  state.identities = [];
  await click("Reload keys");
  expect(screen.getByRole("button", { name: "Remove unavailable key SHA256:AAAA" })).toBeTruthy();
  expect(disabled()).toBe(true);
  state.rosterError = true;
  await click("Reload keys");
  expect(screen.getByText(/Set SSH_AUTH_SOCK/)).toBeTruthy();
});
it("retains draft choices across tasks and failed readiness reads", async () => {
  const { state, client } = await setup({ initial: { node: "desk", destination: "keep-me" } });
  await task();
  fireEvent.click(screen.getByLabelText("Remember this destination"));
  await click("Back");
  await task("Enable SSH on a node");
  expect(screen.queryByLabelText("SSH destination")).toBeNull();
  await click("Back");
  await task();
  state.readyError = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["ssh-readiness"] });
  });
  await settle();
  expect(disabled()).toBe(true);
  expect((screen.getByLabelText("SSH destination") as HTMLInputElement).value).toBe("keep-me");
  expect((screen.getByLabelText("Remember this destination") as HTMLInputElement).checked).toBe(true);
});
it("holds launch and navigation until the parent attaches the subshell", async () => {
  let finish!: () => void;
  const { calls } = await setup({
    initial: { node: "desk", destination: "target" },
    onCreated: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  await task();
  await click("Start SSH subshell");
  expect(disabled("Starting SSH subshell…")).toBe(true);
  expect(disabled("Back")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Starting SSH subshell…" }));
  expect(calls.filter((c) => c.path === "/api/ssh/launch")).toHaveLength(1);
  await act(async () => finish());
});
it("node settings setup has one form and Done closes without launching", async () => {
  const { calls } = await setup({ initial: { node: "keys" }, settingsEntry: true });
  await click("Set up SSH");
  await task("Enable SSH on a node");
  await click("Done");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
});

it("keeps the chosen remote node selected when returning through the task chooser", async () => {
  await setup({ initial: { node: "desk", destination: "target" } });
  await task();
  fireEvent.click(screen.getByRole("radio", { name: "Use another node’s keys" }));
  await settle();
  await choose("Use keys from", "keys");
  await click("Back");
  await task();
  expect(screen.getByRole("radio", { name: "Use another node’s keys" }).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByRole("combobox", { name: "Use keys from" }) as HTMLInputElement).value).toBe("keys");
  expect(disabled()).toBe(true);
});
