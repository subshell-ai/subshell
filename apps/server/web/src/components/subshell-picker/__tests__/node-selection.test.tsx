import { afterEach, describe, expect, it } from "bun:test";
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
import { useState } from "react";
import { canSubmit, emptyNewSubshellForm, type NewSubshellFormValue } from "../launch-form-rules";
import { NewSubshellForm } from "../new-subshell-form";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const provider = "xvfb-x11vnc";
const installed = (harnessId: string) => ({ harnessId, name: harnessId, installed: true });
function node(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    name: id === "local" ? "Server" : "Other node",
    kind: id === "local" ? "local" : "agent",
    status: "online",
    canLaunch: true,
    canManage: true,
    canRetire: true,
    access: "owner",
    maintenance: false,
    harnesses: [installed("claude-code"), installed("terminal")],
    virtualDisplayEnabled: true,
    virtualDisplayProvider: provider,
    virtualDisplayProviders: [provider],
    ...overrides,
  } as Node;
}
const local = node("local");
const ready = { supported: true, missing: [] };
const seed: NewSubshellFormValue = {
  ...emptyNewSubshellForm(),
  harnessId: "claude-code",
  presetId: "preset",
  workingDir: "/old-project",
  virtualDisplay: true,
  displayProvider: provider,
  displaySize: { width: 1440, height: 900 },
  promptBlocks: [{ localId: "task", kind: "custom", description: "Review", body: "Review this code" }],
  saveAsPreset: true,
  presetName: "New preset",
};
async function setup(other: Node, probe: (id: string) => unknown | Promise<unknown> = () => ready) {
  const calls: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/display-readiness")) {
      const answer = await probe(url.pathname.split("/")[3]);
      return answer instanceof Response ? answer : json(answer);
    }
    if (url.pathname === "/api/nodes") return json({ nodes: [local, other] });
    if (url.pathname === "/api/plugins")
      return json({
        plugins: [
          { id: "claude-code", name: "Claude Code", type: "agent-harness", installed: true, enabled: true },
          { id: "terminal", name: "Terminal", type: "terminal", installed: true, enabled: true },
        ],
      });
    if (url.pathname === "/api/presets")
      return json([
        {
          id: "preset",
          name: "Original",
          harnessId: "claude-code",
          flagsJson: null,
          envJson: null,
          settingsJson: null,
        },
      ]);
    if (url.pathname === "/api/files/recent") return json({ paths: [], home: `/${url.searchParams.get("node")}/home` });
    if (url.pathname === "/api/subshells") return json([]);
    return json({ own: [], shared: [] });
  }) as typeof fetch;
  let latest = seed;
  let change!: (value: NewSubshellFormValue) => void;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [value, setValue] = useState(seed);
    latest = value;
    change = setValue;
    return <NewSubshellForm value={value} onChange={setValue} />;
  }
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/", component: Harness });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(canSubmit(latest)).toBe(true));
  return {
    latest: () => latest,
    client,
    calls,
    switchNode: async (nodeId: string) => {
      await act(async () => change({ ...latest, nodeId }));
    },
  };
}

describe("node-dependent launch selections", () => {
  it("allows choosing a different node and clears the incompatible agent, preset, and display together", async () => {
    const form = await setup(node("other", { virtualDisplayEnabled: false, harnesses: [installed("terminal")] }));
    const picker = screen.getByRole("combobox", { name: "Node" });
    fireEvent.focus(picker);
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    const option = await screen.findByRole("option", { name: /Other node/ });
    expect(option.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(option);
    await waitFor(() => expect(form.latest().nodeId).toBe("other"));
    await waitFor(() => expect(form.latest().workingDir).toBe("/other/home"));
    expect(form.latest()).toMatchObject({
      harnessId: "",
      presetId: null,
      virtualDisplay: false,
      promptBlocks: seed.promptBlocks,
      saveAsPreset: true,
      presetName: "New preset",
    });
    expect(form.latest().displayProvider).toBeUndefined();
    expect(form.latest().displaySize).toBeUndefined();
    expect(canSubmit(form.latest())).toBe(false);
    expect(screen.getByText(/Claude Code can't run on Other node/)).toBeTruthy();
    expect(screen.getByText(/Virtual display was turned off/)).toBeTruthy();
    const agent = screen.getByRole("combobox", { name: "Agent" });
    fireEvent.focus(agent);
    fireEvent.keyDown(agent, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Terminal" }));
    await waitFor(() => expect(canSubmit(form.latest())).toBe(true));
    expect(form.latest().harnessId).toBe("terminal");
    expect(form.latest().harnessResetReason).toBeUndefined();
  });

  it.each([
    { supported: false, missing: [] },
    { supported: true, missing: ["xauth"] },
  ])("waits for a node's check before clearing an unsupported or unprepared display: %j", async (result) => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const form = await setup(node("other"), (id) => (id === "other" ? pending : ready));
    await form.switchNode("other");
    await waitFor(() => expect(form.calls.some((p) => p.includes("/other/display-readiness"))).toBe(true));
    expect(form.latest().virtualDisplay).toBe(true);
    expect(canSubmit(form.latest())).toBe(false);
    await act(async () => release(result));
    await waitFor(() => expect(form.latest().virtualDisplay).toBe(false));
    expect(form.latest().harnessId).toBe("claude-code");
    expect(form.latest().presetId).toBe("preset");
    expect(canSubmit(form.latest())).toBe(true);
  });

  it("drops a provider disabled on the new node instead of silently replacing it", async () => {
    const form = await setup(
      node("other", { virtualDisplayProvider: "native-example", virtualDisplayProviders: ["native-example"] }),
    );
    await form.switchNode("other");
    await waitFor(() => expect(form.latest().virtualDisplay).toBe(false));
    expect(form.latest().displayProvider).toBeUndefined();
    expect(form.latest().displayResetReason).toContain("provider is disabled");
  });

  it("keeps compatible selections and ignores a late result from a node already left", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const form = await setup(node("other"), (id) => (id === "other" ? pending : ready));
    await form.switchNode("other");
    await waitFor(() => expect(form.calls.some((p) => p.includes("/other/display-readiness"))).toBe(true));
    await form.switchNode("local");
    await waitFor(() => expect(canSubmit(form.latest())).toBe(true));
    await act(async () => release({ supported: false, missing: [] }));
    expect(form.latest()).toMatchObject({
      nodeId: "local",
      harnessId: seed.harnessId,
      presetId: seed.presetId,
      virtualDisplay: true,
      displayProvider: provider,
      displaySize: seed.displaySize,
      promptBlocks: seed.promptBlocks,
    });
    expect(form.latest().displayResetReason).toBeUndefined();
  });

  it("keeps the display selected after a failed check and recovers on recheck", async () => {
    let fail = true;
    const form = await setup(node("other"), (id) =>
      id === "other" && fail
        ? new Response(JSON.stringify({ message: "Node is reconnecting." }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          })
        : ready,
    );
    await form.switchNode("other");
    await screen.findByText(/Node is reconnecting/);
    expect(form.latest().virtualDisplay).toBe(true);
    expect(canSubmit(form.latest())).toBe(false);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(canSubmit(form.latest())).toBe(true));
    expect(form.latest().virtualDisplay).toBe(true);
  });

  it("clears an agent that becomes unavailable while the form is open", async () => {
    const form = await setup(node("other"));
    await act(async () =>
      form.client.setQueryData(["nodes"], { nodes: [{ ...local, harnesses: [installed("terminal")] }, node("other")] }),
    );
    await waitFor(() => expect(form.latest().harnessId).toBe(""));
    expect(form.latest().presetId).toBeNull();
    expect(canSubmit(form.latest())).toBe(false);
  });
});
