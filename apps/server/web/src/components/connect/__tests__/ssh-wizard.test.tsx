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
    enableError: false,
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
      if (state.enableError) return json({ message: "Enable denied" }, 403);
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

async function task() {
  await settle();
}

function disabled(name = "Start SSH subshell") {
  return (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
}
it("opens directly on the connection form", async () => {
  const { calls } = await setup({ initial: { node: "desk", destination: "target" } });
  expect(screen.queryByRole("radiogroup", { name: "SSH action" })).toBeNull();
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
it("enables an owned node only when starting the subshell", async () => {
  const { calls } = await setup({
    initial: { node: "desk", destination: "target" },
    machines: [machine("desk", false)],
  });
  await task();
  expect(disabled()).toBe(false);
  expect(screen.queryByRole("button", { name: "Enable SSH" })).toBeNull();
  expect(screen.getByText(/Starting this subshell will enable outgoing SSH/)).toBeTruthy();
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  await click("Start SSH subshell");
  await waitFor(() => expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(true));
  expect(calls.findIndex((c) => c.path.endsWith("/ssh-enabled"))).toBeLessThan(
    calls.findIndex((c) => c.path === "/api/ssh/launch"),
  );
});
it("shows owner guidance and blocks unauthorized configuration", async () => {
  const { calls } = await setup({
    initial: { node: "shared", destination: "target" },
    machines: [machine("shared", false, false)],
  });
  await task();
  expect(screen.queryByRole("button", { name: "Enable SSH" })).toBeNull();
  expect(screen.getByText(/Ask this node’s owner to enable it/)).toBeTruthy();
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
it("retains draft choices after failed readiness reads", async () => {
  const { state, client } = await setup({ initial: { node: "desk", destination: "keep-me" } });
  await task();
  fireEvent.click(screen.getByLabelText("Remember this destination"));
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
  expect(disabled("Cancel")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Starting SSH subshell…" }));
  expect(calls.filter((c) => c.path === "/api/ssh/launch")).toHaveLength(1);
  await act(async () => finish());
});
it("settings opens the connection form and Cancel closes without launching", async () => {
  const { calls } = await setup({ initial: { node: "keys" }, settingsEntry: true });
  await click("Connect over SSH");
  expect(screen.getByLabelText("SSH destination")).toBeTruthy();
  await click("Cancel");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
});

it("keeps the chosen remote node selected while choosing keys", async () => {
  await setup({ initial: { node: "desk", destination: "target" } });
  await task();
  fireEvent.click(screen.getByRole("radio", { name: "Use another node’s keys" }));
  await settle();
  await choose("Use keys from", "keys");
  expect(screen.getByRole("radio", { name: "Use another node’s keys" }).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByRole("combobox", { name: "Use keys from" }) as HTMLInputElement).value).toBe("keys");
  expect(disabled()).toBe(true);
});

it("selects SSH options by clicking their descriptions", async () => {
  await setup({ initial: { node: "desk", destination: "target" } });
  fireEvent.click(screen.getByRole("radio", { name: "Use another node’s keys" }));
  await settle();
  fireEvent.click(document.getElementById("ssh-keys-node-name")!);
  await settle();
  expect(screen.getByRole("radio", { name: "Use the connecting node’s keys" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(screen.queryByRole("combobox", { name: "Use keys from" })).toBeNull();
});

it("does not launch when enabling fails", async () => {
  const { state, calls } = await setup({
    initial: { node: "desk", destination: "target" },
    machines: [machine("desk", false)],
  });
  state.enableError = true;
  await click("Start SSH subshell");
  await screen.findByRole("alert");
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
});
it("rechecks permission before enabling", async () => {
  const { state, calls } = await setup({
    initial: { node: "desk", destination: "target" },
    machines: [machine("desk", false)],
  });
  state.machines = [machine("desk", false, false)];
  await click("Start SSH subshell");
  await screen.findByRole("alert");
  expect(calls.some((c) => c.path.endsWith("/ssh-enabled") || c.path === "/api/ssh/launch")).toBe(false);
});
it("blocks automatic enablement when another blocker exists", async () => {
  const blocked = machine("desk", false);
  blocked.blockers.push({ code: "NODE_IN_MAINTENANCE", message: "This node is in maintenance." });
  const { calls } = await setup({ initial: { node: "desk", destination: "target" }, machines: [blocked] });
  expect(disabled()).toBe(true);
  expect(screen.queryByRole("button", { name: "Enable SSH" })).toBeNull();
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

it("shows guidance instead of a key picker when no other nodes are available", async () => {
  await setup({ initial: { node: "desk", destination: "target" }, machines: [machine("desk")] });
  fireEvent.click(screen.getByRole("radio", { name: "Use another node’s keys" }));
  await settle();
  expect(screen.queryByRole("combobox", { name: "Use keys from" })).toBeNull();
  expect(screen.getByText(/No other nodes are available to supply keys/)).toBeTruthy();
  const addNode = screen.getByRole("link", { name: "Add another node (opens in a new tab)" });
  expect(addNode.getAttribute("href")).toBe("/nodes");
  expect(addNode.getAttribute("target")).toBe("_blank");
  expect(disabled()).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Use the connecting node’s keys" }));
  await settle();
  expect(disabled()).toBe(false);
});

it("enables the key-source node on Start, then requires an explicit key selection", async () => {
  const { calls } = await setup({
    initial: { node: "desk", keyHome: "keys", destination: "target" },
    machines: [machine("desk"), machine("keys", false)],
  });
  expect(screen.queryByRole("button", { name: "Enable SSH" })).toBeNull();
  expect(screen.getByText(/Starting this subshell will enable SSH on the node supplying keys/)).toBeTruthy();
  await waitFor(() => expect(disabled()).toBe(false));
  await click("Start SSH subshell");
  await screen.findByRole("checkbox", { name: "Work key" });
  expect(calls.some((c) => c.path === "/api/nodes/keys/ssh-enabled")).toBe(true);
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
  expect(disabled()).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Work key" }));
  await settle();
  await click("Start SSH subshell");
  expect(calls.find((c) => c.path === "/api/ssh/launch")?.body).toEqual({
    node: "desk",
    keyHome: "keys",
    destination: "target",
    fingerprints: ["SHA256:AAAA"],
  });
});
it("cannot implicitly enable another owner's key-source node", async () => {
  await setup({
    initial: { node: "desk", keyHome: "keys", destination: "target" },
    machines: [machine("desk"), machine("keys", false, false)],
  });
  expect(disabled()).toBe(true);
  expect(screen.queryByRole("button", { name: "Enable SSH" })).toBeNull();
  expect(screen.getByText(/Ask this node’s owner to enable it/)).toBeTruthy();
});

it("removes the waiting notice when refreshed readiness reports SSH enabled", async () => {
  const { state, client } = await setup({
    initial: { node: "shared", destination: "target" },
    machines: [machine("shared", false, false)],
  });
  const guidance = screen.getByText(/Ask this node’s owner to enable it/);
  expect(guidance.textContent).toContain("SSH is off on this machine.");
  expect(screen.getByText("Waiting for SSH to be enabled…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  state.machines = [machine("shared", true, false)];
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["ssh-readiness"] });
  });
  await waitFor(() => expect(screen.queryByText("Waiting for SSH to be enabled…")).toBeNull());
  await waitFor(() => expect(disabled()).toBe(false));
}, 10000);

it("switches from another node's keys to an interactive password without sending key choices", async () => {
  const { calls } = await setup({
    initial: { node: "desk", keyHome: "keys", destination: "target", fingerprints: ["SHA256:AAAA"] },
  });
  fireEvent.click(
    screen.getByText("Enter your password in the terminal when SSH asks for it. Subshell won’t save it."),
  );
  await settle();
  expect(screen.queryByRole("combobox", { name: "Use keys from" })).toBeNull();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  await click("Start SSH subshell");
  expect(calls.find((c) => c.path === "/api/ssh/launch")?.body).toEqual({
    node: "desk",
    destination: "target",
    authentication: "password",
  });
});

for (const ownerLabel of ["Alex Smith", "alex@example.com"]) {
  it(`names the shared node owner as ${ownerLabel}`, async () => {
    await setup({
      initial: { node: "shared", destination: "target" },
      machines: [{ ...machine("shared", false, false), ownerLabel }],
    });
    expect(screen.getByText(`Ask this node’s owner (${ownerLabel}) to enable it.`, { exact: false })).toBeTruthy();
    expect(disabled()).toBe(true);
  });
}
