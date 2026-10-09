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
    if (path === "/api/ssh/saved-hosts") return json({ saved: [], recent: [], defaultNodeId: null });
    if (path === "/api/ssh/aliases") return json({ aliases: ["work"], includeCycle: false, truncated: false });
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
  fireEvent.change(field, { target: { value: name } });
  await settle();
  fireEvent.click(await screen.findByRole("option", { name }));
  await settle();
}

it("opens the three intents from empty SSH state with a single primary wizard action", async () => {
  const { calls } = await setup({ machines: [], start: false });
  expect(screen.getByText("No machine is ready for SSH")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add a node" })).toBeNull();
  await click("SSH Wizard");
  expect(screen.getByRole("button", { name: "Connect to a destination" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Prepare a machine for SSH" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Use keys from another machine" })).toBeTruthy();
  expect(calls.some((c) => c.path === "/api/ssh/identities")).toBe(false);
});

it("connect intent skips satisfied setup, focuses steps, and starts only after review", async () => {
  const { calls } = await setup({ initial: { node: "desk" } });
  await click("Connect to a destination");
  expect(document.activeElement?.textContent).toBe("Choose a destination");
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("SSH destination"), { target: { value: "deploy@example:22" } });
  await settle();
  await next();
  await next();
  expect(screen.getByRole("heading", { name: "Choose where your keys live" })).toBeTruthy();
  await click("Use connecting machine’s own keys");
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
  await click("Start SSH subshell");
  expect(calls.filter((c) => c.path === "/api/ssh/launch")).toEqual([
    { path: "/api/ssh/launch", method: "POST", body: { node: "desk", destination: "deploy@example:22" } },
  ]);
});

it("prepare intent explicitly enables SSH and never launches; Connect now returns to same form", async () => {
  const { calls } = await setup({
    initial: { node: "desk", keyHome: "unavailable", fingerprints: ["SHA256:AAAA"] },
    machines: [machine("desk", false)],
  });
  await click("Prepare a machine for SSH");
  await next();
  expect(screen.getByRole("heading", { name: "Prepare the connecting machine" })).toBeTruthy();
  await click("Enable SSH");
  await next();
  expect(screen.getByRole("heading", { name: "Your SSH setup" })).toBeTruthy();
  expect(calls.filter((c) => c.path.endsWith("/ssh-enabled"))).toHaveLength(1);
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
  expect(calls.some((c) => c.path === "/api/ssh/identities")).toBe(false);
  await click("Connect now");
  expect(screen.getByLabelText("SSH destination")).toBeTruthy();
});

it("shared launchable machines can connect while unauthorized configuration remains unavailable", async () => {
  const { calls } = await setup({ initial: { node: "shared" }, machines: [machine("shared", false, false)] });
  await click("Prepare a machine for SSH");
  await next();
  expect(screen.queryByRole("button", { name: "Enable SSH" })).toBeNull();
  expect(screen.queryByRole("button", { name: /settings$/ })).toBeNull();
  expect(screen.getByText(/This machine’s owner can enable SSH/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

it("remote keys intent includes the named server and requires an explicit fingerprint selection", async () => {
  const { calls } = await setup({
    initial: { node: "desk" },
    machines: [machine("desk", true, false), machine("local", true, true, "local")],
  });
  await click("Use keys from another machine");
  await next();
  await choose("Use SSH keys from", "Named server");
  await next();
  expect(calls.filter((c) => c.path === "/api/ssh/identities")).toHaveLength(1);
  expect(screen.getByRole("checkbox", { name: "Work key" }).getAttribute("aria-checked")).toBe("false");
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Work key" }));
  await settle();
  await next();
  expect(calls.some((c) => c.path === "/api/ssh/launch")).toBe(false);
  await click("Use this setup");
  expect(screen.getByLabelText("SSH destination")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("SSH destination"), { target: { value: "target" } });
  await settle();
  await click("Start SSH subshell");
  expect(calls.find((c) => c.path === "/api/ssh/launch")?.body).toEqual({
    node: "desk",
    destination: "target",
    keyHome: "local",
    fingerprints: ["SHA256:AAAA"],
  });
});

it("retains canonical destination, remember, and explicit keys across wizard cancel and apply", async () => {
  const { calls } = await setup({
    initial: { node: "desk", destination: "target", keyHome: "keys", fingerprints: ["SHA256:AAAA"] },
    start: false,
  });
  fireEvent.click(screen.getByLabelText("Remember this destination"));
  await click("SSH Wizard");
  await click("Use keys from another machine");
  await next();
  await next();
  expect(screen.getByRole("checkbox", { name: "Work key" }).getAttribute("aria-checked")).toBe("true");
  await click("Cancel wizard");
  expect((screen.getByLabelText("SSH destination") as HTMLInputElement).value).toBe("target");
  expect((screen.getByLabelText("Remember this destination") as HTMLInputElement).checked).toBe(true);
  await click("Start SSH subshell");
  expect(calls.find((c) => c.path === "/api/ssh/launch")?.body).toEqual({
    node: "desk",
    destination: "target",
    keyHome: "keys",
    fingerprints: ["SHA256:AAAA"],
  });
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ node: "desk", destination: "target" });
});

it("blocks disappeared selected keys and explains unreachable service agents separately from empty rosters", async () => {
  const { state } = await setup({ initial: { node: "desk", keyHome: "keys", fingerprints: ["SHA256:AAAA"] } });
  await click("Use keys from another machine");
  await next();
  await next();
  state.identities = [];
  await click("Retry keys");
  expect(screen.getByText(/No keys are loaded/)).toBeTruthy();
  expect(screen.getByText(/selected key is no longer available/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  state.rosterError = true;
  await click("Retry keys");
  expect(screen.getByText(/interactive shell’s SSH agent may differ/)).toBeTruthy();
  state.rosterError = false;
  state.identities = [{ fingerprint: "SHA256:AAAA", comment: "Work key" }];
  await click("Retry keys");
  await next();
  expect(screen.getByRole("heading", { name: "Your SSH setup" })).toBeTruthy();
});

it("preserves wizard draft during readiness failures and an offline selected machine", async () => {
  const { state, client } = await setup({ initial: { node: "desk", destination: "keep-me" } });
  await click("Connect to a destination");
  await next();
  state.readyError = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["ssh-readiness"] });
  });
  await settle();
  expect(screen.getByRole("heading", { name: "Choose a connecting machine" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  state.readyError = false;
  state.machines = [
    {
      ...machine("desk"),
      node: { ...machine("desk").node, status: "offline" },
      canConnect: false,
      blockers: [{ code: "NODE_OFFLINE", message: "Bring this machine online." }],
    },
    machine("other"),
  ];
  await click("Retry");
  await next();
  expect(screen.getByText("Bring this machine online.")).toBeTruthy();
  await click("Back");
  await click("Back");
  expect((screen.getByLabelText("SSH destination") as HTMLInputElement).value).toBe("keep-me");
});

it("matches only its consumed setup key, retains key/method across Back, and distinguishes enrolled offline", async () => {
  const { state, calls } = await setup({ machines: [] });
  await click("Prepare a machine for SSH");
  await click("Add a machine");
  await click("Generate setup key");
  await click("Desktop App");
  expect(screen.getByText("nsk_mine")).toBeTruthy();
  await click("Back");
  await click("Add a machine");
  expect(screen.getByText("nsk_mine")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Desktop App" }).getAttribute("aria-pressed")).toBe("true");
  state.machines = [machine("unrelated")];
  await click("Retry enrollment status");
  expect(screen.getByText("Waiting for this setup key to enroll a machine.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  state.consumedNodeId = "enrolled";
  state.machines.push({
    ...machine("enrolled", false),
    node: { ...machine("enrolled", false).node, status: "offline" },
  });
  await click("Retry enrollment status");
  expect(screen.getByText("Machine enrolled. Waiting for this machine to come online.")).toBeTruthy();
  await next();
  expect(screen.getByText("enrolled")).toBeTruthy();
  expect(calls.filter((c) => c.path === "/api/nodes/setup-keys" && c.method === "POST")).toHaveLength(1);
});

it("disabled enrollment explains policy and preserves existing-machine preparation", async () => {
  await setup({ initial: { node: "desk" }, enrollmentAllowed: false });
  await click("Prepare a machine for SSH");
  expect((screen.getByRole("button", { name: "Add a machine" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Adding nodes is turned off/)).toBeTruthy();
  await next();
  expect(screen.getByRole("heading", { name: "Your SSH setup" })).toBeTruthy();
});

it("settings/node entry preselects its machine and Done returns to settings", async () => {
  const { calls } = await setup({ initial: { node: "keys" }, settingsEntry: true });
  expect(calls.some((c) => c.path === "/api/ssh/readiness")).toBe(false);
  await click("SSH Wizard");
  await click("Prepare a machine for SSH");
  expect((screen.getByRole("combobox", { name: "Machine to prepare" }) as HTMLInputElement).value).toBe("keys");
  await next();
  await click("Done");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("holds one launch through an asynchronous creation callback and cannot submit twice", async () => {
  let finish: (() => void) | undefined;
  const created: string[] = [];
  const { calls } = await setup({
    initial: { node: "desk", destination: "target" },
    onCreated: async (id) => {
      created.push(id);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  await click("Connect to a destination");
  await next();
  await next();
  await click("Use connecting machine’s own keys");
  await click("Start SSH subshell");
  expect(created).toEqual(["created-ssh"]);
  expect((screen.getByRole("button", { name: "Starting SSH subshell…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Cancel wizard" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Starting SSH subshell…" }));
  expect(calls.filter((c) => c.path === "/api/ssh/launch")).toHaveLength(1);
  await act(async () => {
    finish?.();
  });
});
