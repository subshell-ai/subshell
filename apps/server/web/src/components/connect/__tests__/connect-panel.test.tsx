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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConnectPanel } from "@/components/connect/connect-panel";

/**
 * The /connect behavior contract (plan 3 Task 3), pinned on the composed
 * panel with the wire mocked the way `new-subshell-form.test.tsx` mocks it
 * (fetch, not the hooks - the hooks are pinned by `use-ssh.test.tsx`). The
 * refusal CODE matrix is pinned purely in `ssh-refusal.test.ts`; two arms run
 * through the panel here to prove the wiring (the 422 out of the parsed body,
 * the 409 under the machine field).
 */

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

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
    canRetire: true,
    canLaunch: true,
    allowedDirs: [],
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    sshEnabled: false,
    sshWideForwards: false,
    held: null,
    ...overrides,
  };
}

const HOST_A = node({ id: "a1", name: "mac mini", sshEnabled: true });
const HOST_B = node({ id: "b1", name: "studio", sshEnabled: false });
const HOST_C = node({ id: "c1", name: "server room", sshEnabled: true });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface WireOpts {
  nodes?: Node[];
  nodesResponse?: () => Response;
  settings?: unknown;
  ledger?: unknown;
  aliases?: string[];
  launch?: () => Response | Promise<Response>;
  presets?: () => Response | Promise<Response>;
}

/** Mock the whole /connect surface and record every call with its body. */
function mockFetch(opts: WireOpts = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    calls.push({
      method,
      url: path + url.search,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    if (path === "/api/settings/public") return Promise.resolve(json(opts.settings ?? {}));
    if (path === "/api/ssh/readiness")
      return Promise.resolve(
        opts.nodesResponse?.() ??
          json({
            machines: (opts.nodes ?? []).map((node) => ({
              node,
              canConnect:
                node.canLaunch && node.sshEnabled && !node.held && !node.maintenance && node.status === "online",
              canConfigure: node.canManage,
              blockers: !node.sshEnabled
                ? [
                    {
                      code: "SSH_GATE_OFF",
                      message:
                        node.kind === "local"
                          ? "SSH is off here. An admin can switch it on from this machine's settings."
                          : "SSH is off on this machine. Its owner can switch it on from this machine's settings.",
                    },
                  ]
                : node.status !== "online"
                  ? [{ code: "NODE_OFFLINE", message: "Start Subshell on this machine to bring it online." }]
                  : [],
            })),
          }),
      );
    if (path === "/api/ssh/identities")
      return Promise.resolve(json({ identities: [{ fingerprint: "SHA256:AAAA", comment: "Work key" }] }));
    if (path === "/api/ssh/recent-destinations" && method === "GET") {
      return Promise.resolve(json(opts.ledger ?? { saved: [], recent: [], defaultNodeId: null }));
    }
    if (path === "/api/presets") {
      if (method === "POST")
        return Promise.resolve(
          json({
            ...JSON.parse(String(init?.body)),
            id: "ssh-preset",
            destination: "resolved.example:22",
            createdAt: "t",
            updatedAt: "t",
          }),
        );
      return Promise.resolve(opts.presets?.() ?? json([]));
    }
    if (path === "/api/ssh/preferences") return Promise.resolve(json({ defaultNodeId: "a1" }));
    if (path === "/api/ssh/aliases") {
      return Promise.resolve(json({ aliases: opts.aliases ?? [], includeCycle: false, truncated: false }));
    }
    if (path === "/api/ssh/launch") {
      return Promise.resolve(opts.launch ? opts.launch() : json({ subshell: { id: "s-1" } }, 201));
    }
    return Promise.resolve(json({}));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

interface Rendered {
  calls: Call[];
  /** Current path: the navigation assertion reads the router state live. */
  pathname: () => string;
  restore: () => void;
}

async function renderPanel(
  opts: WireOpts,
  initial?: { preset?: string; node?: string; keyHome?: string; destination?: string; fingerprints?: string[] },
): Promise<Rendered> {
  const { calls, restore } = mockFetch(opts);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ConnectPanel initial={initial} startInWizard={false} />,
  });
  const paneRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      paneRoute,
      ...["/nodes", "/nodes/$id"].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
  return { calls, pathname: () => router.state.location.pathname, restore };
}

/** Flush query/effect updates inside act() (the launch-form test idiom). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** Base UI opens its machine popup on the pointer path, not a bare click. */
function openMachinePopup(): void {
  const input = document.getElementById("connect-machine");
  if (!input) throw new Error("no machine field");
  act(() => {
    for (const type of ["pointerdown", "pointerup"]) {
      input.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }));
    }
    for (const type of ["mousedown", "mouseup", "click"]) {
      input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  });
}

function machineInput(): HTMLInputElement {
  return screen.getByPlaceholderText("Choose a node") as HTMLInputElement;
}

function destinationInput(): HTMLInputElement {
  return screen.getByPlaceholderText("user@hostname:22 or an SSH alias") as HTMLInputElement;
}

/** The destination field opens on focus (the working-directory posture). */
function focusDestination(): void {
  fireEvent.focus(destinationInput());
}

/** Commit a typed host through its mirror row (the free-text path, §7). */
async function commitTyped(text: string): Promise<void> {
  focusDestination();
  await settle();
  fireEvent.change(destinationInput(), { target: { value: text } });
  await settle();
  fireEvent.click(await screen.findByRole("button", { name: text }));
  await settle();
}

async function clickConnect(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /^Start SSH subshell$/ }));
  await settle();
}

afterEach(cleanup);

describe("machine disclosure (contract 1)", () => {
  it("keeps a gated-off machine visible, greyed, with the reason naming the remedy", async () => {
    const { pathname, restore } = await renderPanel({ nodes: [HOST_A, HOST_B] });
    try {
      // HOST_A is the sole SSH-enabled machine, so it pre-selects honestly -
      // and HOST_B still stands in the list, disabled.
      openMachinePopup();
      await settle();
      const studio = await screen.findByRole("option", { name: /studio/ });
      expect(studio.getAttribute("data-disabled")).toBe("");
      // The row carries the remedy, not just the cause (the changeset's
      // promise; the server's gateCause sentences are the pattern).
      expect(studio.textContent).toContain(
        "SSH is off on this machine. Its owner can switch it on from this machine's settings.",
      );
      expect(pathname()).toBe("/");
    } finally {
      restore();
    }
  });

  it("names the admin remedy on a gated-off local row, kind-aware like the server's gate", async () => {
    const localOff = node({ id: "loc", name: "this host", kind: "local", sshEnabled: false });
    const { restore } = await renderPanel({ nodes: [HOST_A, localOff] });
    try {
      openMachinePopup();
      await settle();
      const row = await screen.findByRole("option", { name: /this host/ });
      expect(row.getAttribute("data-disabled")).toBe("");
      expect(row.textContent).toContain("SSH is off here. An admin can switch it on from this machine's settings.");
    } finally {
      restore();
    }
  });

  it("pre-selects the stored default machine", async () => {
    const { restore } = await renderPanel({
      nodes: [HOST_A, HOST_C],
      ledger: { saved: [], recent: [], defaultNodeId: "c1" },
    });
    try {
      await waitFor(() => expect(machineInput().value).toBe("server room"));
    } finally {
      restore();
    }
  });

  it("pre-selects the single SSH-enabled machine with the preference unset, and asks nothing extra", async () => {
    const { restore } = await renderPanel({ nodes: [HOST_A, HOST_B] });
    try {
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
      // The one usable machine is pre-selected honestly: no gold question
      // mark, no requirement caption (Connect is live once a destination stands).
      const label = document.querySelector('label[for="connect-machine"]');
      expect(label?.querySelector('[class*="after:content"]')).toBeNull();
      expect(screen.queryByText("Choose a node to connect from first.")).toBeNull();
    } finally {
      restore();
    }
  });

  it("a stale default with one enabled machine still pre-selects it, unmarked", async () => {
    // The ledger points at a vanished node; the only usable machine wins.
    const { restore } = await renderPanel({
      nodes: [HOST_A, HOST_B],
      ledger: { saved: [], recent: [], defaultNodeId: "vanished-node" },
    });
    try {
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
      const label = document.querySelector('label[for="connect-machine"]');
      expect(label?.querySelector('[class*="after:content"]')).toBeNull();
    } finally {
      restore();
    }
  });

  for (const unavailable of [
    [],
    [HOST_B],
    [{ ...HOST_A, status: "offline" as const }],
    [{ ...HOST_A, maintenance: true }],
    [{ ...HOST_A, canLaunch: false }],
  ]) {
    it(`replaces the form when no machine can run SSH: ${JSON.stringify(unavailable)}`, async () => {
      const { calls, restore } = await renderPanel({ nodes: unavailable }, { node: HOST_A.id, destination: "work" });
      try {
        expect(screen.getByText("Connect over SSH")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Start SSH subshell" })).toBeNull();
        expect(screen.queryByLabelText("SSH destination")).toBeNull();
        expect(screen.getByRole("button", { name: "Set up SSH" })).toBeTruthy();
        expect(calls.some((c) => c.url.startsWith("/api/ssh/aliases"))).toBe(false);
        expect(calls.some((c) => c.url === "/api/ssh/launch")).toBe(false);
      } finally {
        restore();
      }
    });
  }

  it("shows a retry instead of an empty state when machines cannot be loaded", async () => {
    let failed = true;
    const { restore } = await renderPanel({
      nodesResponse: () =>
        failed
          ? json({}, 503)
          : json({ machines: [{ node: HOST_A, canConnect: true, canConfigure: true, blockers: [] }] }),
    });
    try {
      expect(screen.getByText("Could not load connecting machines.")).toBeTruthy();
      expect(screen.queryByText("Connect over SSH")).toBeNull();
      failed = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
    } finally {
      restore();
    }
  });

  it("does not offer enrollment when the instance forbids it", async () => {
    const { restore } = await renderPanel({
      nodes: [],
      settings: { viewerIsAdmin: false, allowNodeEnrollment: false },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Set up SSH" }));
      await settle();
      await settle();
      await settle();
      expect(screen.queryByRole("button", { name: "Add a machine" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("summarizes unavailable machines without listing their individual blockers", async () => {
    const { restore } = await renderPanel({
      nodes: [node({ id: "local", name: "Server", kind: "local", sshEnabled: false }), HOST_B],
      settings: { viewerIsAdmin: true },
    });
    try {
      expect(screen.getByText("Connect over SSH")).toBeTruthy();
      expect(screen.getByText("None of your nodes can start an SSH connection yet.")).toBeTruthy();
      expect(screen.queryByText(/SSH is off here/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Open Server settings" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Open studio settings" })).toBeNull();
      expect(screen.getByRole("button", { name: "Set up SSH" })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("blocks a stale selected machine even when another machine is ready", async () => {
    const { calls, restore } = await renderPanel(
      { nodes: [{ ...HOST_A, status: "offline" }, HOST_C] },
      { node: HOST_A.id, destination: "work" },
    );
    try {
      expect((screen.getByRole("button", { name: "Start SSH subshell" }) as HTMLButtonElement).disabled).toBe(true);
      await clickConnect();
      expect(screen.getByText(/Choose another connecting machine to continue/)).toBeTruthy();
      expect(calls.some((c) => c.url === "/api/ssh/launch")).toBe(false);
    } finally {
      restore();
    }
  });

  it("several enabled machines and no preference is a required question: gold *, gold caption, no POST", async () => {
    const { calls, restore } = await renderPanel({ nodes: [HOST_A, HOST_C] });
    try {
      expect(machineInput().value).toBe(""); // never silently chosen
      const label = document.querySelector('label[for="connect-machine"]');
      expect(label?.querySelector('[class*="after:content"]')).not.toBeNull(); // the gold star
      await commitTyped("box.example");
      await clickConnect();
      const caption = screen.getByText("Choose a node to connect from first.");
      expect(caption.className).toContain("text-amber-600"); // gold: nothing typed yet, not red
      expect(calls.filter((c) => c.url === "/api/ssh/launch")).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("destination field (contract 2)", () => {
  it("feeds the grouped rows: Recent, and the picked machine's config", async () => {
    const ledger = {
      recent: [
        {
          id: "r1",
          destination: "db.example.com:22",
          alias: null,
          nodeId: "a1",
          savedAt: null,
          lastConnectAt: "2026-10-06T00:00:00.000Z",
        },
      ],
      defaultNodeId: "a1",
    };
    const { restore } = await renderPanel({ nodes: [HOST_A], ledger, aliases: ["workbox"] });
    try {
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
      focusDestination();
      await settle();
      const popup = await waitFor(() => {
        const el = document.getElementById("connect-destination-panel");
        if (!el) throw new Error("popup not open");
        return el;
      });
      // Scoped to the popup: "Recent" is also the ledger's own heading below.
      expect(within(popup).getByText("Recent")).toBeDefined();
      expect(within(popup).getByText("From mac mini's config")).toBeDefined();
      expect(within(popup).getByRole("button", { name: "workbox" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("asks the machine for its aliases only once a gate-ON machine is picked", async () => {
    const empty = await renderPanel({ nodes: [] });
    try {
      // No machine at all: the picker asks nothing (a half-open panel must not
      // ping a node with node= empty).
      await settle();
      expect(empty.calls.filter((c) => c.url.startsWith("/api/ssh/aliases"))).toEqual([]);
    } finally {
      empty.restore();
    }
    cleanup(); // one tree at a time: the second render must not stack queries
    const picked = await renderPanel({ nodes: [HOST_A] });
    try {
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
      expect(picked.calls.some((c) => c.url === "/api/ssh/aliases?node=a1")).toBe(true);
    } finally {
      picked.restore();
    }
  });

  it("accepts a typed host directly without requiring a suggestion click", async () => {
    const { calls, restore } = await renderPanel({ nodes: [HOST_A] });
    try {
      fireEvent.change(destinationInput(), { target: { value: "box.example" } });
      expect(destinationInput().value).toBe("box.example"); // the held echo is what will launch
      await clickConnect();
      const post = calls.find((c) => c.url === "/api/ssh/launch");
      expect(post?.body).toEqual({ node: "a1", destination: "box.example" });
    } finally {
      restore();
    }
  });

  it("saving a config alias preserves alias settings under the saved canonical guard", async () => {
    const { calls, restore } = await renderPanel({ nodes: [HOST_A], aliases: ["workbox"] });
    try {
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
      focusDestination();
      await settle();
      fireEvent.click(await screen.findByRole("button", { name: "workbox" }));
      await settle();
      fireEvent.click(screen.getByRole("checkbox", { name: "Save as preset" }));
      fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Work" } });
      await clickConnect();
      expect(calls.find((c) => c.url === "/api/ssh/launch")?.body).toEqual({
        node: "a1",
        destination: "workbox",
        expectedDestination: "resolved.example:22",
      });
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/presets")).toBe(true));
      const put = calls.find((c) => c.method === "POST" && c.url === "/api/presets");
      expect(put?.body).toMatchObject({
        kind: "ssh",
        name: "Work",
        nodeId: "a1",
        destination: "workbox",
        alias: "workbox",
        authentication: "connecting",
      });
    } finally {
      restore();
    }
  });
});

describe("connect and the ledger (contracts 3, 6)", () => {
  it("the button shows the process's own line while it runs and lands on the pane at 201", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, _init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/ssh/launch") return gate.then(() => json({ subshell: { id: "s-9" } }, 201));
      if (url.pathname === "/api/ssh/readiness")
        return Promise.resolve(
          json({ machines: [{ node: HOST_A, canConnect: true, canConfigure: true, blockers: [] }] }),
        );
      if (url.pathname === "/api/presets") return Promise.resolve(json([]));
      if (url.pathname === "/api/ssh/recent-destinations")
        return Promise.resolve(json({ saved: [], recent: [], defaultNodeId: null }));
      return Promise.resolve(json({}));
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({
          getParentRoute: () => rootRoute,
          path: "/",
          component: () => <ConnectPanel startInWizard={false} />,
        }),
        createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id", component: () => null }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultPreload: false,
    });
    await router.load();
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await settle();
    try {
      await commitTyped("box.example");
      fireEvent.click(screen.getByRole("button", { name: /^Start SSH subshell$/ }));
      await settle();
      const button = screen.getByRole("button", { name: /Connecting/ }); // no spinner: the button owns the wait
      expect((button as HTMLButtonElement).disabled).toBe(true);
      release();
      await waitFor(() => expect(router.state.location.pathname).toBe("/subshells/s-9"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("Save as preset starts unchecked and creates only when selected", async () => {
    const off = await renderPanel({ nodes: [HOST_A] });
    try {
      expect(screen.getByRole("checkbox", { name: "Save as preset" }).getAttribute("aria-checked")).toBe("false");
      await commitTyped("box.example");
      await clickConnect();
      await settle();
      expect(off.calls.filter((c) => c.method === "POST" && c.url === "/api/presets")).toEqual([]);
    } finally {
      off.restore();
    }
    cleanup(); // one tree at a time
    const on = await renderPanel({ nodes: [HOST_A] });
    try {
      await commitTyped("box.example");
      fireEvent.click(screen.getByRole("checkbox", { name: "Save as preset" }));
      fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Work" } });
      await clickConnect();
      await waitFor(() => expect(on.calls.some((c) => c.method === "POST" && c.url === "/api/presets")).toBe(true));
      const put = on.calls.find((c) => c.method === "POST" && c.url === "/api/presets");
      expect(put?.body).toMatchObject({ kind: "ssh", name: "Work", nodeId: "a1", destination: "box.example" });
    } finally {
      on.restore();
    }
  });

  it("Select this node by default PATCHes the connecting-machine preference", async () => {
    const { calls, restore } = await renderPanel({ nodes: [HOST_A] });
    try {
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
      fireEvent.click(screen.getByRole("button", { name: "Select this node by default" }));
      await waitFor(() =>
        expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/ssh/preferences")).toBe(true),
      );
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ defaultNodeId: "a1" });
    } finally {
      restore();
    }
  });
});

describe("refusals and disclosure (contracts 4, 5)", () => {
  it("renders a 422 outcome's blocked settings verbatim in red, past the message slice", async () => {
    const settings = ["ProxyCommand", "LocalForward", ...Array.from({ length: 30 }, (_, i) => `Setting${i}`)];
    const raw = JSON.stringify({ outcome: { accepted: false, code: "unsupported_setting", settings } });
    expect(raw.length).toBeGreaterThan(200); // the 200-char message slice is exercised
    const { restore } = await renderPanel({
      nodes: [HOST_A],
      launch: () => json({ outcome: { accepted: false, code: "unsupported_setting", settings } }, 422),
    });
    try {
      await commitTyped("web01");
      await clickConnect();
      const line = await screen.findByText(
        (_text, el) =>
          el?.tagName === "P" &&
          (el.textContent ?? "").startsWith("This SSH configuration uses settings Subshell doesn't support:"),
      );
      expect(line.className).toContain("text-destructive"); // a hard server refusal: red
      expect(line.textContent).toContain("Setting29"); // the WHOLE list, not the 200-char slice
      expect(line.textContent).toContain("Update them on the connecting machine and try again.");
    } finally {
      restore();
    }
  });

  it("names the machine in its own 409 sentence, under the machine field", async () => {
    const { restore } = await renderPanel({
      nodes: [HOST_A],
      launch: () => json({ errId: "e1", code: "NODE_OFFLINE", message: "offline", statusCode: 409 }, 409),
    });
    try {
      await commitTyped("web01");
      await clickConnect();
      expect(await screen.findByText("mac mini is offline. Start its Subshell daemon and try again.")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("associates the destination format description with its input", async () => {
    const { restore } = await renderPanel({ nodes: [HOST_A] });
    try {
      expect(destinationInput().getAttribute("aria-describedby")).toBe("connect-destination-disclosure");
    } finally {
      restore();
    }
  });

  it("wires the machine requirement caption as the picker's description", async () => {
    // The same aria posture the destination field pins above: whatever the
    // machine picker is explaining about itself is its accessible
    // description, named by id only while it is on screen.
    const { restore } = await renderPanel({ nodes: [HOST_A, HOST_C] });
    try {
      await waitFor(() => expect(document.getElementById("connect-machine-requirement")).not.toBeNull());
      expect(machineInput().getAttribute("aria-describedby")).toContain("connect-machine-requirement");
    } finally {
      restore();
    }
  });
});

describe("relay launch with current launch access", () => {
  it("sends the selected key machine and preserves the returned connection choices", async () => {
    const { calls, restore } = await renderPanel(
      { nodes: [HOST_A, HOST_C] },
      {
        node: HOST_A.id,
        keyHome: HOST_C.id,
        destination: "theo@build.example.com:2222",
        fingerprints: ["SHA256:AAAA"],
      },
    );
    try {
      // Start stays disabled until the key-home roster query settles
      // (rosterReady). The fixed settle() in renderPanel doesn't guarantee that
      // under a loaded CI runner, so a bare click can land on the still-pending
      // gate and send nothing. Wait for the control to go live before clicking.
      await waitFor(
        () =>
          expect((screen.getByRole("button", { name: /^Start SSH subshell$/ }) as HTMLButtonElement).disabled).toBe(
            false,
          ),
        { timeout: 4000 },
      );
      await clickConnect();
      expect(calls.find((c) => c.url === "/api/ssh/launch")?.body).toEqual({
        node: HOST_A.id,
        keyHome: HOST_C.id,
        fingerprints: ["SHA256:AAAA"],
        destination: "theo@build.example.com:2222",
      });
    } finally {
      restore();
    }
  });
  it("blocks a stale key-machine choice instead of silently using another machine's keys", async () => {
    const { calls, restore } = await renderPanel(
      { nodes: [HOST_A, { ...HOST_C, status: "offline" }] },
      { node: HOST_A.id, keyHome: HOST_C.id, destination: "work" },
    );
    try {
      expect((screen.getByRole("button", { name: "Start SSH subshell" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/machine supplying your keys is unavailable/)).toBeTruthy();
      expect(calls.some((c) => c.url === "/api/ssh/launch")).toBe(false);
    } finally {
      restore();
    }
  });
});

it("a delayed URL preset cannot overwrite an edited draft during or after a pending launch", async () => {
  let releasePresets!: (response: Response) => void;
  let releaseLaunch!: (response: Response) => void;
  const presets = new Promise<Response>((resolve) => {
    releasePresets = resolve;
  });
  const pendingLaunch = new Promise<Response>((resolve) => {
    releaseLaunch = resolve;
  });
  const { calls, restore } = await renderPanel(
    { nodes: [HOST_A], presets: () => presets, launch: () => pendingLaunch },
    { preset: "slow", node: "a1" },
  );
  try {
    await commitTyped("my-edited-host");
    fireEvent.click(screen.getByRole("button", { name: "Start SSH subshell" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/ssh/launch")).toBe(true));
    releasePresets(
      json([
        {
          id: "slow",
          kind: "ssh",
          name: "Late preset",
          nodeId: "a1",
          destination: "late-host:22",
          authentication: "local-key",
          keyHome: null,
          fingerprints: [],
        },
      ]),
    );
    await settle();
    await settle();
    expect(destinationInput().value).toBe("my-edited-host");
    expect(calls.find((call) => call.url === "/api/ssh/launch")?.body).toEqual({
      node: "a1",
      destination: "my-edited-host",
    });
    releaseLaunch(json({ code: "SSH_RELAY_OPEN_FAILED", message: "Try again" }, 409));
    await screen.findByText("Try again");
    expect(destinationInput().value).toBe("my-edited-host");
  } finally {
    restore();
  }
});

it("carries added port forwards in the launch body, and holds Add until the editor row is valid (spec 2026-10-15)", async () => {
  const { calls, restore } = await renderPanel({
    nodes: [HOST_A],
    launch: () => json({ subshell: { id: "pane-fwd" } }, 201),
  });
  try {
    fireEvent.change(destinationInput(), { target: { value: "build.example" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Advanced SSH options" }));
    await settle();
    // Nobody declared a forward: the section is one button, not a form.
    expect(screen.queryByLabelText(/Local port/) === null).toBe(true);
    // The machine's bind rule is stated up front, not discovered at launch.
    expect(screen.getByText(/127\.0\.0\.1 only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    // Loopback-only machine: no bind field offered.
    expect(screen.queryByLabelText(/Bind address/)).toBeNull();
    // Disabled state rides aria-disabled, not the attribute: the node-admin
    // Button stays focusable while it explains why Add is held (Base UI).
    const addDisabled = () => {
      const b = screen.getByRole("button", { name: "Add port forward" }) as HTMLButtonElement;
      return b.disabled || b.getAttribute("aria-disabled") === "true";
    };
    // A pristine editor adds nothing: Add is disabled and no complaint shows.
    expect(addDisabled()).toBe(true);
    expect(screen.queryByText(/listen port/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Local port/), { target: { value: "5432" } });
    await settle();
    // Half a row: the listen port alone is not a forward.
    expect(addDisabled()).toBe(true);
    expect(screen.getByText(/host to reach/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Target host/), { target: { value: "db.internal" } });
    fireEvent.change(screen.getByLabelText(/Target port/), { target: { value: "5432" } });
    await settle();
    expect(addDisabled()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    // The forward lands in the table and the editor folds away.
    expect(screen.getByText("loopback:5432")).toBeTruthy();
    expect(screen.queryByLabelText(/Local port/) === null).toBe(true);
    // Reopening starts clean: the kind sticks, the values do not.
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    expect((screen.getByLabelText(/Local port/) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await clickConnect();
    await waitFor(() => expect(calls.some((call) => call.url === "/api/ssh/launch")).toBe(true));
    expect(calls.find((call) => call.url === "/api/ssh/launch")?.body).toMatchObject({
      node: "a1",
      destination: "build.example",
      forwards: [{ kind: "local", listenPort: 5432, bindHost: null, targetHost: "db.internal", targetPort: 5432 }],
    });
  } finally {
    restore();
  }
});

it("removes an added forward from the table before the launch", async () => {
  const { calls, restore } = await renderPanel({
    nodes: [HOST_A],
    launch: () => json({ subshell: { id: "pane-fwd2" } }, 201),
  });
  try {
    fireEvent.change(destinationInput(), { target: { value: "build.example" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Advanced SSH options" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    fireEvent.change(screen.getByLabelText(/Local port/), { target: { value: "8080" } });
    fireEvent.change(screen.getByLabelText(/Target host/), { target: { value: "app.internal" } });
    fireEvent.change(screen.getByLabelText(/Target port/), { target: { value: "3000" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    expect(screen.getByText("loopback:8080")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove this forward" }));
    await settle();
    expect(screen.queryByText("loopback:8080")).toBeNull();
    await clickConnect();
    await waitFor(() => expect(calls.some((call) => call.url === "/api/ssh/launch")).toBe(true));
    const launchBody = calls.find((call) => call.url === "/api/ssh/launch")?.body as Record<string, unknown>;
    expect(launchBody.forwards).toBeUndefined();
  } finally {
    restore();
  }
});

it("refuses to add a second forward on a port the table already holds", async () => {
  const { restore } = await renderPanel({ nodes: [HOST_A] });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Advanced SSH options" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    fireEvent.change(screen.getByLabelText(/Local port/), { target: { value: "5432" } });
    fireEvent.change(screen.getByLabelText(/Target host/), { target: { value: "db.internal" } });
    fireEvent.change(screen.getByLabelText(/Target port/), { target: { value: "5432" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    // The next row on the same port is refused at the Add button, not at launch.
    // Adding folded the editor, so it opens again clean and the whole row is retyped.
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    fireEvent.change(screen.getByLabelText(/Local port/), { target: { value: "5432" } });
    fireEvent.change(screen.getByLabelText(/Target host/), { target: { value: "cache.internal" } });
    fireEvent.change(screen.getByLabelText(/Target port/), { target: { value: "5432" } });
    await settle();
    const addButton = screen.getByRole("button", { name: "Add port forward" }) as HTMLButtonElement;
    expect(addButton.disabled || addButton.getAttribute("aria-disabled") === "true").toBe(true);
    expect(screen.getByText(/already binds that port/i)).toBeTruthy();
    // A press on the held button changes nothing: the table keeps its one row.
    fireEvent.click(addButton);
    await settle();
    expect(screen.getAllByRole("button", { name: "Remove this forward" })).toHaveLength(1);
  } finally {
    restore();
  }
});

it("offers the bind address on a machine whose owner allows wide binds", async () => {
  const HOST_WIDE = node({ id: "w1", name: "router box", sshEnabled: true, sshWideForwards: true });
  const { restore } = await renderPanel({ nodes: [HOST_WIDE] });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Advanced SSH options" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add port forward" }));
    await settle();
    expect(screen.getByLabelText(/Bind address/)).toBeTruthy();
    // The owner already allowed wide binds: no loopback-only sentence.
    expect(screen.queryByText(/127\.0\.0\.1 only/) === null).toBe(true);
  } finally {
    restore();
  }
});
