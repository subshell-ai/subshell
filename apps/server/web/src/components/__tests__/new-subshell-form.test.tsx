import { afterEach, describe, expect, it } from "bun:test";
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
import {
  canSubmit,
  emptyNewSubshellForm,
  hideMachineField,
  launchableNodes,
  NewSubshellForm,
  type NewSubshellFormValue,
  pickNodeDefault,
} from "@/components/subshell-picker/new-subshell-form";
import { toSubshellCreateBody } from "@/hooks/use-create-subshell";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import type { Node } from "@/types/node";

/**
 * The Agent-first launch form (spec 2026-09-13 §5): searchable Agent picker
 * (the grey grid itself is pinned in lib/__tests__/subshell-compat.test.ts),
 * the optional Preset row with its inline create, the honest empty-state
 * hints, and the defaults the densest effect in the SPA composes. Assertions
 * run on form state and the DOM around the inputs — the closed combobox is a
 * real <input>, so its value is not a text node; the picker's real behavior
 * is e2e-pinned (12-nodes).
 */
function node(overrides: Partial<Node>): Node {
  return {
    id: "n",
    name: "node",
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
    access: "owner",
    canManage: true,
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    ...overrides,
  };
}

function plugin(p: {
  id: string;
  name?: string;
  type?: "agent-harness" | "terminal";
  installed?: boolean;
  enabled?: boolean;
}): InstancePluginRow {
  return {
    id: p.id,
    name: p.name ?? p.id,
    description: "",
    installed: p.installed ?? true,
    enabled: p.enabled ?? true,
    builtIn: true,
    ...(p.type !== undefined ? { type: p.type } : {}),
  };
}

function preset(p: { id: string; harnessId: string; name?: string }) {
  return {
    id: p.id,
    harnessId: p.harnessId,
    name: p.name ?? "preset",
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

const CLAUDE_ON = { harnessId: "claude-code", name: "Claude Code", installed: true };
const TERM_ON = { harnessId: "terminal", name: "Terminal", installed: true };
const CLAUDE = plugin({ id: "claude-code", name: "Claude Code" });
const TERM = plugin({ id: "terminal", name: "Terminal", type: "terminal" });

const LOCAL = node({ id: "local", name: "this host", kind: "local", access: "view", harnesses: [CLAUDE_ON] });
const AGENT_ONLINE = node({ id: "a1", name: "mac mini", status: "online", harnesses: [CLAUDE_ON] });
const AGENT_INCOMPAT = node({ id: "a3", name: "studio", harnesses: [] });
const AGENT_OFFLINE = node({ id: "a2", name: "old laptop", status: "offline", harnesses: [CLAUDE_ON] });

/** Pathname+search of the most recent /api/presets request — the wire pin. */
let lastPresetsUrl: string | null = null;

/** The `/api/files/recent` answer, or a function of the requested node scope. */
type RecentStub = { paths: { path: string; label: string | null }[]; home: string | null };

interface MockOpts {
  /** Answer GET /api/nodes this many ms late — the ordering where recents
   *  resolve while the node pick is still unsettled (review round 2). */
  nodesDelayMs?: number;
  /** Hold GET /api/subshells until this promise resolves — the UNANSWERED
   *  list the agent-default gate exists for (cross-client review,
   *  2026-09-13). Deterministic; no wall-clock race. */
  subshellsGate?: Promise<unknown>;
  /** Answer POST /api/presets with this row (the inline-create case). */
  createdPreset?: ReturnType<typeof preset>;
}

function mockFetch(
  nodes: Node[],
  plugins: InstancePluginRow[] = [],
  presets: unknown[] = [],
  subshells: unknown[] = [],
  recent: RecentStub | ((node: string | null) => RecentStub) = { paths: [], home: null },
  opts: MockOpts = {},
) {
  lastPresetsUrl = null;
  // A MUTABLE list: a POST appends, so the invalidation refetch after an
  // inline create answers like a server that kept the row (a static stub
  // would erase the created preset from the cache a beat after selecting it).
  const presetStore = [...presets];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/nodes") {
      const body = () => new Response(JSON.stringify({ nodes }));
      return opts.nodesDelayMs
        ? new Promise<Response>((r) => setTimeout(() => r(body()), opts.nodesDelayMs))
        : Promise.resolve(body());
    }
    if (path === "/api/plugins") {
      return Promise.resolve(new Response(JSON.stringify({ plugins })));
    }
    if (path === "/api/presets" && method === "GET") {
      lastPresetsUrl = path + url.search;
      // Mirror the route's rule since the store-scoping follow-up: the list
      // is the whole store-scoped answer for EVERY caller — no variants, no
      // local probe.
      return Promise.resolve(new Response(JSON.stringify(presetStore)));
    }
    if (path === "/api/presets" && method === "POST") {
      const created = opts.createdPreset ?? preset({ id: "new-p", harnessId: "claude-code" });
      presetStore.push(created);
      return Promise.resolve(new Response(JSON.stringify(created)));
    }
    if (path === "/api/subshells") {
      const body = () => new Response(JSON.stringify(subshells));
      // The gate holds the response UNANSWERED until released: an in-flight
      // query is not an error and not a value — the exact state the agent
      // default must wait on.
      return opts.subshellsGate ? opts.subshellsGate.then(() => body()) : Promise.resolve(body());
    }
    if (path === "/api/files/recent") {
      const scope = url.searchParams.get("node");
      const body = typeof recent === "function" ? recent(scope) : recent;
      return Promise.resolve(new Response(JSON.stringify(body)));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/** Flush pending query/effect updates inside act() — 50 ms is generous for
 *  these Promise.resolve-backed mocks, and it keeps "not wrapped in act" out
 *  of the log (see the ffe50bc warning-flood fix). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/**
 * The form is fully caller-controlled; this harness owns the state it would.
 * `holdValue` ignores onChange instead — pinning the render to `initial` so a
 * test can probe what the hint gate itself decides about a pair the live form
 * would have re-homed away from (e.g. an offline pick).
 */
async function renderForm(initial: NewSubshellFormValue = emptyNewSubshellForm(), holdValue = false, firstRun = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: NewSubshellFormValue = initial;
  function Harness() {
    const [value, setValue] = useState<NewSubshellFormValue>(initial);
    latest = value;
    return <NewSubshellForm value={value} onChange={holdValue ? () => {} : setValue} firstRun={firstRun} />;
  }
  // The honest hints render `<Link>`s (a router context is required) — the
  // same minimal memory-router wrapper the local-launch-card test uses.
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Harness });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  // RouterProvider paints nothing until the router has loaded once.
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // Let the initial queries (nodes, plugins, presets, subshells) land inside
  // act(): their results rebuild the picker items and fire Base UI internal
  // state syncs that would otherwise apply outside act and flood the log.
  await settle();
  return { latest: () => latest, client };
}

afterEach(cleanup);

describe("pickNodeDefault", () => {
  it("keeps a valid pick and the local default while local is present", () => {
    const nodes = [LOCAL, AGENT_ONLINE, AGENT_OFFLINE];
    expect(pickNodeDefault(nodes, "local")).toBe("local");
    expect(pickNodeDefault(nodes, "a1")).toBe("a1");
  });
  it("falls to the sole selectable option when local vanished", () => {
    expect(pickNodeDefault([AGENT_ONLINE, AGENT_OFFLINE], "local")).toBe("a1");
  });
  it("forces an explicit choice when local vanished and several nodes remain", () => {
    expect(pickNodeDefault([AGENT_ONLINE, AGENT_INCOMPAT], "local")).toBe("");
  });
});

describe("NewSubshellForm agent/preset defaults", () => {
  it("defaults to Local, picks an agent, is submittable, and asks Agent before Preset before Node", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE, AGENT_OFFLINE], [CLAUDE]);
    try {
      const { latest } = await renderForm();
      expect(screen.getByPlaceholderText("Choose a node")).toBeDefined();
      expect(screen.getByPlaceholderText("Choose an agent")).toBeDefined();
      await waitFor(() => expect(latest().nodeId).toBe("local"));
      await waitFor(() => expect(latest().harnessId).toBe("claude-code"));
      const labels = Array.from(document.querySelectorAll("label"), (l) => l.textContent);
      expect(labels.indexOf("Agent")).toBeLessThan(labels.indexOf("Preset"));
      expect(labels.indexOf("Preset")).toBeLessThan(labels.indexOf("Node"));
      expect(canSubmit({ harnessId: "claude-code", presetId: null, workingDir: "/tmp/x", nodeId: "local" })).toBe(true);
      // Wire pin: ONE list for every surface. The store-scoped server
      // already answers for agents that run only on another node, so the
      // launch form reads the plain URL the /presets page does — no query,
      // no second cache key (the node=any variant that escaped invalidation
      // is gone; the node-only-agent regression it guarded is fixed at the
      // server, spec 2026-09-13 follow-up).
      expect(lastPresetsUrl).toBe("/api/presets");
    } finally {
      restore();
    }
  });

  it("defaults to the most recent subshell's agent when it is still usable", async () => {
    // Both agents usable against the host, pi the more recent subshell's
    // agent — the recents rule outranks catalog order.
    const host = node({
      id: "local",
      name: "this host",
      kind: "local",
      access: "view",
      harnesses: [CLAUDE_ON, { harnessId: "pi", name: "Pi", installed: true }],
    });
    const restore = mockFetch(
      [host],
      [CLAUDE, plugin({ id: "pi", name: "Pi" })],
      [],
      [
        { id: "s1", harnessId: "claude-code", createdAt: "2026-09-01T00:00:00.000Z" },
        { id: "s2", harnessId: "pi", createdAt: "2026-09-12T00:00:00.000Z" },
      ],
    );
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().harnessId).toBe("pi"));
    } finally {
      restore();
    }
  });

  it("an unusable recent agent falls through to what CAN run", async () => {
    // Pi was the recent agent but the host's inventory does not carry it:
    // the recents rule releases rather than parking the form on a refusal.
    const restore = mockFetch(
      [LOCAL],
      [CLAUDE, plugin({ id: "pi", name: "Pi" })],
      [],
      [{ id: "s2", harnessId: "pi", createdAt: "2026-09-12T00:00:00.000Z" }],
    );
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().harnessId).toBe("claude-code"));
    } finally {
      restore();
    }
  });

  it("waits for the subshells list to ANSWER before the default fires", async () => {
    // The host runs both agents; pi is the most recent subshell's agent. If
    // the blank-only fill fired while the list was still in flight it would
    // land on the first-usable tier (claude-code, catalog order) and the
    // recent-wins tier would be silently lost for the whole dialog session
    // — the same gate-the-answered-not-the-value rule as the dir pre-fill.
    const host = node({
      id: "local",
      name: "this host",
      kind: "local",
      access: "view",
      harnesses: [CLAUDE_ON, { harnessId: "pi", name: "Pi", installed: true }],
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const restore = mockFetch(
      [host],
      [CLAUDE, plugin({ id: "pi", name: "Pi" })],
      [],
      [{ id: "s2", harnessId: "pi", createdAt: "2026-09-12T00:00:00.000Z" }],
      undefined,
      { subshellsGate: gate },
    );
    try {
      // Nodes, plugins and presets have all answered by now; the list has
      // not — and the fill must NOT fire anyway.
      const { latest } = await renderForm();
      expect(latest().harnessId).toBe("");
      // Release it: the fill lands on PI — the recent tier — proving it
      // stayed armed rather than silently settling for first-usable.
      release();
      await waitFor(() => expect(latest().harnessId).toBe("pi"));
    } finally {
      restore();
    }
  });

  it("falls to the first usable agent with Terminal last", async () => {
    // Both usable against the host; Terminal first in catalog order. The
    // default skips it (spec §5) — a plain shell is a fallback, not the
    // headline.
    const host = node({
      id: "local",
      name: "this host",
      kind: "local",
      access: "view",
      harnesses: [CLAUDE_ON, TERM_ON],
    });
    const restore = mockFetch([host], [TERM, CLAUDE]);
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().harnessId).toBe("claude-code"));
    } finally {
      restore();
    }
  });

  it("Terminal is the default when it is ALL that can run", async () => {
    // The clean-machine case spec 2026-09-10 §6 built the terminal plugin
    // for: no agent CLI anywhere, one launchable option, and "Terminal last"
    // yields to nothing.
    const host = node({ id: "local", name: "this host", kind: "local", access: "view", harnesses: [TERM_ON] });
    const restore = mockFetch([host], [CLAUDE, TERM]);
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().harnessId).toBe("terminal"));
    } finally {
      restore();
    }
  });

  it("an agent the picked node cannot run is never the default", async () => {
    // The re-home case: local vanished at mount; the sole node runs Terminal
    // only. Reading the disabled set against the left-behind row parked the
    // old form on an unusable pairing — the agent default must read the node
    // the pick ENDS UP on.
    const AGENT_ONLY = node({ id: "a1", name: "mac", harnesses: [TERM_ON] });
    const restore = mockFetch([AGENT_ONLY], [CLAUDE, TERM]);
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().nodeId).toBe("a1"));
      await waitFor(() => expect(latest().harnessId).toBe("terminal"));
    } finally {
      restore();
    }
  });
});

describe("NewSubshellForm preset row", () => {
  it("lists None first and keeps a foreign preset from surviving the guard", async () => {
    const restore = mockFetch(
      [LOCAL, AGENT_ONLINE],
      [CLAUDE, plugin({ id: "pi", name: "Pi" })],
      [
        preset({ id: "p-claude", harnessId: "claude-code", name: "Fast" }),
        preset({ id: "p-pi", harnessId: "pi", name: "Pi one" }),
      ],
    );
    try {
      // The held pair is inconsistent: a Pi preset under the Claude agent.
      const { latest } = await renderForm({
        harnessId: "claude-code",
        presetId: "p-pi",
        workingDir: "/x",
        nodeId: "local",
      });
      await waitFor(() => expect(latest().presetId).toBeNull());
      // And the picker stands at None (Base UI prints the mapped label).
      await waitFor(() => expect(screen.getByText("None")).toBeDefined());
    } finally {
      restore();
    }
  });

  it("offers a preset for an agent only the SELECTED node runs", async () => {
    // The pairing the LOCAL-filtered list used to hide (final review,
    // 2026-09-13; settled server-side, spec follow-up): the control-plane
    // host has no claude binary, "mac mini" does, and the claude-code
    // PLUGIN is in the instance store — so the one store-scoped list already
    // answers with the preset, no escape-hatch query. With the node picked
    // and its agent chosen, the preset is offered and survives the guard;
    // per-node fit stays the grey matrix, never a list filter.
    const NO_CLAUDE_LOCAL = node({
      id: "local",
      name: "this host",
      kind: "local",
      access: "view",
      harnesses: [TERM_ON],
    });
    const restore = mockFetch(
      [NO_CLAUDE_LOCAL, AGENT_ONLINE],
      [CLAUDE, TERM],
      [preset({ id: "p-claude", harnessId: "claude-code", name: "Fast" })],
    );
    try {
      const { latest } = await renderForm({
        harnessId: "claude-code",
        presetId: "p-claude",
        workingDir: "/x",
        nodeId: "a1",
      });
      await settle();
      expect(latest().nodeId).toBe("a1");
      expect(latest().presetId).toBe("p-claude");
      expect(screen.getByText("Fast")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("a chosen agent's own preset survives the guard and reads on the trigger", async () => {
    const restore = mockFetch([LOCAL], [CLAUDE], [preset({ id: "p-claude", harnessId: "claude-code", name: "Fast" })]);
    try {
      const { latest } = await renderForm({
        harnessId: "claude-code",
        presetId: "p-claude",
        workingDir: "/x",
        nodeId: "local",
      });
      await settle();
      expect(latest().presetId).toBe("p-claude");
      expect(screen.getByText("Fast")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("changing the agent through the picker resets the preset", async () => {
    // The host runs BOTH agents here — a greyed row is inert by contract, and
    // the pick must be a real one.
    const host = node({
      id: "local",
      name: "this host",
      kind: "local",
      access: "view",
      harnesses: [CLAUDE_ON, { harnessId: "pi", name: "Pi", installed: true }],
    });
    const restore = mockFetch(
      [host, AGENT_ONLINE],
      [CLAUDE, plugin({ id: "pi", name: "Pi" })],
      [preset({ id: "p-claude", harnessId: "claude-code", name: "Fast" })],
    );
    try {
      const { latest } = await renderForm({
        harnessId: "claude-code",
        presetId: "p-claude",
        workingDir: "/x",
        nodeId: "local",
      });
      const input = screen.getByPlaceholderText("Choose an agent") as HTMLInputElement;
      // Keyboard-open the picker (happy-dom cannot emulate the pointer path
      // Base UI arms on); a held selection does not filter the freshly
      // opened list.
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: "Pi" }));
      await waitFor(() => expect(latest().harnessId).toBe("pi"));
      expect(latest().presetId).toBeNull();
    } finally {
      restore();
    }
  });

  it("shows the hint for the agent, appending the zero-presets sentence", async () => {
    const restore = mockFetch([LOCAL], [CLAUDE], []);
    try {
      await renderForm();
      await waitFor(() =>
        expect(screen.getByText("Saved flags, env vars and restart policy for Claude Code.")).toBeDefined(),
      );
      expect(screen.getByText("No presets for Claude Code yet.")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("+ opens the nested create dialog, and a created preset becomes the selection", async () => {
    const created = preset({ id: "p-new", harnessId: "claude-code", name: "Brand new" });
    const restore = mockFetch([LOCAL], [CLAUDE], [], [], undefined, { createdPreset: created });
    try {
      const { latest, client } = await renderForm({
        harnessId: "claude-code",
        presetId: null,
        workingDir: "/x",
        nodeId: "local",
      });
      fireEvent.click(screen.getByRole("button", { name: "New preset" }));
      const dialog = await screen.findByRole("dialog", { name: "New preset for Claude Code" });
      // Locked posture: the agent is static text, never a second select.
      expect(dialog.textContent).toContain("Claude Code");
      expect(dialog.querySelector("#preset-harness")).toBeNull();
      fireEvent.change(dialog.querySelector("#preset-name") as HTMLInputElement, { target: { value: "Brand new" } });
      fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
      await waitFor(() =>
        expect((client.getQueryData<{ id: string }[]>(PRESETS_QUERY_KEY) ?? []).some((r) => r.id === "p-new")).toBe(
          true,
        ),
      );
      await waitFor(() => expect(latest().presetId).toBe("p-new"));
      // The trigger reads the new row's name; the dialog is gone.
      expect(screen.getByText("Brand new")).toBeDefined();
      expect(screen.queryByRole("dialog", { name: "New preset for Claude Code" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("first run hides the Preset row entirely", async () => {
    // A second machine so the Machine field is on screen at all.
    const restore = mockFetch([LOCAL, AGENT_ONLINE], [CLAUDE]);
    try {
      await renderForm(emptyNewSubshellForm(), false, true);
      const labels = Array.from(document.querySelectorAll("label"), (l) => l.textContent);
      expect(labels).toContain("Agent");
      expect(labels).toContain("Machine");
      expect(labels).not.toContain("Preset");
      expect(labels).not.toContain("Node");
      expect(screen.queryByRole("button", { name: "New preset" })).toBeNull();
      // The two first-run sentences the setup screen teaches with.
      expect(screen.getByText("The agent CLI this subshell runs. Terminal needs nothing installed.")).toBeDefined();
      expect(screen.getByText("Where this subshell runs. You can add other machines as nodes later.")).toBeDefined();
    } finally {
      restore();
    }
  });
});

describe("NewSubshellForm honest hints", () => {
  it("nothing on the picked node can run an agent → the hint, with a node link", async () => {
    const restore = mockFetch([node({ id: "a1", name: "bare", harnesses: [] })], [CLAUDE]);
    try {
      await renderForm({ harnessId: "", presetId: null, workingDir: "/tmp/x", nodeId: "a1" });
      // The node name sits inside the hint's <Link>, so the sentence spans
      // multiple nodes — match the paragraph on its full textContent.
      const hint = await screen.findByText(
        (_text, el) => el?.tagName === "P" && /Nothing installed on bare can run an agent/.test(el.textContent ?? ""),
      );
      expect(hint.textContent).toContain("ask an admin to install a plugin");
      expect(hint.querySelector("a[href*='/nodes/']")).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("loaded-zero plugins on the picked node → the hint still shows (empty ≠ loading)", async () => {
    const restore = mockFetch([node({ id: "a1", name: "bare", harnesses: [] })], []);
    try {
      await renderForm({ harnessId: "", presetId: null, workingDir: "/tmp/x", nodeId: "a1" });
      expect(
        await screen.findByText(
          (_text, el) => el?.tagName === "P" && /Nothing installed on bare can run an agent/.test(el.textContent ?? ""),
        ),
      ).toBeDefined();
    } finally {
      restore();
    }
  });

  it("an offline chosen node never gets the 'nothing installed there' misdiagnosis", async () => {
    const restore = mockFetch([LOCAL, AGENT_OFFLINE], [CLAUDE]);
    try {
      // holdValue pins the pick on the offline node — the live form re-homes
      // it — so this probes the gate itself: the row reasons already say
      // "node offline"; the hint must not claim the node holds no plugins.
      await renderForm({ harnessId: "", presetId: null, workingDir: "/tmp/x", nodeId: "a2" }, true);
      expect(
        screen.queryByText((_text, el) => el?.tagName === "P" && /Nothing installed on/.test(el.textContent ?? "")),
      ).toBeNull();
    } finally {
      restore();
    }
  });

  it("chosen agent runnable on no visible node → the mirror hint", async () => {
    const restore = mockFetch([AGENT_INCOMPAT], [CLAUDE]);
    try {
      await renderForm({ harnessId: "claude-code", presetId: null, workingDir: "/tmp/x", nodeId: "a3" });
      expect(await screen.findByText(/No available node can run Claude Code/)).toBeDefined();
    } finally {
      restore();
    }
  });
});

describe("NewSubshellForm working-dir defaults", () => {
  it("falls back to the node's home directory when there are no recent paths", async () => {
    const restore = mockFetch([LOCAL], [], [], [], { paths: [], home: "/home/ada" });
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().workingDir).toBe("/home/ada"));
    } finally {
      restore();
    }
  });

  it("prefers a recent path over home", async () => {
    const restore = mockFetch([LOCAL], [], [], [], { paths: [{ path: "/srv/app", label: null }], home: "/home/ada" });
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().workingDir).toBe("/srv/app"));
    } finally {
      restore();
    }
  });

  it("never overwrites a directory the caller already holds", async () => {
    const restore = mockFetch([LOCAL], [], [], [], { paths: [], home: "/home/ada" });
    try {
      const { latest } = await renderForm({ ...emptyNewSubshellForm(), workingDir: "/typed/by/hand" });
      await settle();
      expect(latest().workingDir).toBe("/typed/by/hand");
    } finally {
      restore();
    }
  });

  it("takes the directory default from the node the pick ends up on", async () => {
    const AGENT_ONLY = node({ id: "a1", name: "mac", harnesses: [TERM_ON] });
    const restore = mockFetch([AGENT_ONLY], [], [], [], (n) => ({
      paths: [],
      home: n === "a1" ? "/home/on-a1" : "/home/left-behind",
    }));
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().workingDir).toBe("/home/on-a1"));
      expect(latest().nodeId).toBe("a1");
    } finally {
      restore();
    }
  });

  it("will not arm the pre-fill before the node list has settled the pick", async () => {
    // The review's ordering case: the recents query answers WHILE `nodes` is
    // still loading. Arming then fills local's home and closes the door
    // forever — the later re-home (local vanished) cannot re-arm, leaving a
    // directory that exists only on the abandoned node. The same-pass
    // `reHomed` guard cannot see this ordering; only waiting for the node
    // list can.
    const AGENT_ONLY = node({ id: "a1", name: "mac", harnesses: [TERM_ON] });
    const restore = mockFetch(
      [AGENT_ONLY],
      [],
      [],
      [],
      (n) => ({ paths: [], home: n === "a1" ? "/home/on-a1" : "/home/left-behind" }),
      {
        nodesDelayMs: 30,
      },
    );
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().nodeId).toBe("a1"));
      await waitFor(() => expect(latest().workingDir).toBe("/home/on-a1"));
    } finally {
      restore();
    }
  });
});

describe("NewSubshellForm copy", () => {
  it("never asks for a name — the server names it and renaming is its own act", async () => {
    const restore = mockFetch([LOCAL], [CLAUDE]);
    try {
      await renderForm();
      const labels = Array.from(document.querySelectorAll("label"), (l) => l.textContent);
      expect(labels.some((l) => l?.toLowerCase().includes("name"))).toBe(false);
      expect(screen.queryByPlaceholderText("Defaults to date/time")).toBeNull();
    } finally {
      restore();
    }
  });

  it("the visible pick rides the wire, with a presetless launch sending no presetId", async () => {
    const restore = mockFetch([LOCAL], [CLAUDE]);
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().harnessId).toBe("claude-code"));
      const body = toSubshellCreateBody(latest());
      expect(body.harnessId).toBe("claude-code");
      expect("presetId" in body && body.presetId !== undefined).toBe(false);
    } finally {
      restore();
    }
  });
});

/**
 * The machine field is a question, and a question with one possible answer is
 * not one. Only the HOST counts as that case (operator's call, 2026-09-12):
 * once a second machine exists at all, where a subshell runs is worth stating
 * even if only one of them can take it today.
 */
describe("hideMachineField", () => {
  it("hides the field when the host is the only place it could run", () => {
    expect(hideMachineField([LOCAL])).toBe(true);
  });

  it("keeps it for a lone AGENT — a second machine exists, so the answer is news", () => {
    expect(hideMachineField([AGENT_ONLINE])).toBe(false);
  });

  it("keeps it whenever there is a choice", () => {
    expect(hideMachineField([LOCAL, AGENT_ONLINE])).toBe(false);
    expect(hideMachineField([AGENT_ONLINE, AGENT_OFFLINE])).toBe(false);
  });

  // Nothing to hide, and nothing to ask: the empty state renders instead.
  it("does not claim to hide anything when there is nowhere to launch", () => {
    expect(hideMachineField([])).toBe(false);
    expect(hideMachineField([node({ id: "local", kind: "local", canLaunch: false })])).toBe(false);
  });

  // The host with launching switched off is not a target, so a single agent
  // beside it is the sole one — and that one keeps the field.
  it("reads canLaunch, not merely the row count", () => {
    const off = node({ id: "local", kind: "local", canLaunch: false });
    expect(hideMachineField([off, AGENT_ONLINE])).toBe(false);
    expect(hideMachineField([off, node({ id: "local2", kind: "local" })])).toBe(true);
  });
});

describe("launchableNodes", () => {
  it("drops what the server says this viewer cannot launch on", () => {
    const off = node({ id: "local", kind: "local", canLaunch: false });
    expect(launchableNodes([off, AGENT_ONLINE]).map((n) => n.id)).toEqual(["a1"]);
  });

  // An older server omits the field entirely. It must read as launchable, or
  // a cached page would show "nowhere to launch" against a healthy instance.
  it("treats an absent answer as launchable", () => {
    expect(launchableNodes([LOCAL, AGENT_ONLINE]).length).toBe(2);
  });
});

describe("nowhere to launch", () => {
  it("replaces the form with the two ways out, and offers the host switch to whoever manages it", async () => {
    const off = node({ id: "local", name: "Server", kind: "local", canManage: true, canLaunch: false });
    const restore = mockFetch([off], [CLAUDE]);
    try {
      await renderForm();
      await waitFor(() => expect(screen.getByText("No machine can run a subshell")).toBeDefined());
      expect(screen.getByRole("button", { name: "Enable on Server" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Add a node" })).toBeDefined();
      // The form itself is gone — there is no question left to ask.
      expect(screen.queryByLabelText("Working directory")).toBeNull();
    } finally {
      restore();
    }
  });

  it("offers a non-manager only the route they can take, and names who can take the other", async () => {
    const off = node({ id: "local", name: "Server", kind: "local", canManage: false, canLaunch: false });
    const restore = mockFetch([off], [CLAUDE]);
    try {
      await renderForm();
      await waitFor(() => expect(screen.getByText("No machine can run a subshell")).toBeDefined());
      expect(screen.queryByRole("button", { name: /^Enable on/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Add a node" })).toBeDefined();
      expect(screen.getByText(/An admin can switch Server back on/)).toBeDefined();
    } finally {
      restore();
    }
  });
});
