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
import { ConnectPanel, SSH_DISCLOSURE_COPY } from "@/components/connect/connect-panel";

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
    canLaunch: true,
    allowedDirs: [],
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    sshEnabled: false,
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
  ledger?: unknown;
  aliases?: string[];
  launch?: () => Response;
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
    if (path === "/api/nodes") return Promise.resolve(json({ nodes: opts.nodes ?? [] }));
    if (path === "/api/ssh/saved-hosts" && method === "GET") {
      return Promise.resolve(json(opts.ledger ?? { saved: [], recent: [], defaultNodeId: null }));
    }
    if (path === "/api/ssh/saved-hosts" && method === "PUT") {
      return Promise.resolve(
        json({ id: "r1", destination: "x", alias: null, nodeId: "a1", savedAt: "t", lastConnectAt: "t" }),
      );
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
  initial?: { node?: string; keyHome?: string; destination?: string },
): Promise<Rendered> {
  const { calls, restore } = mockFetch(opts);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ConnectPanel initial={initial} />,
  });
  const paneRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, paneRoute]),
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
  return screen.getByPlaceholderText("Choose a machine") as HTMLInputElement;
}

function destinationInput(): HTMLInputElement {
  return screen.getByPlaceholderText("Choose or type a destination") as HTMLInputElement;
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
  fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
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
      expect(screen.queryByText("Choose a connecting machine first.")).toBeNull();
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

  it("a stale default with NO enabled machine: the caption names the missing machine and Connect cannot fire", async () => {
    // The honest dead end: the preference points at a row that is gone and
    // nothing is SSH-enabled. The sentence names the ENVIRONMENT (gold, one
    // line), and the disabled button means Connect can never be a silent
    // no-op: a typed destination alone must not POST.
    const { calls, restore } = await renderPanel({
      nodes: [],
      ledger: { saved: [], recent: [], defaultNodeId: "vanished-node" },
    });
    try {
      expect(machineInput().value).toBe("");
      const caption = screen.getByText("No SSH-enabled machine is available. Enable SSH on a machine first.");
      expect(caption.className).toContain("text-amber-600"); // gold: nothing chosen, not a refused value
      await commitTyped("box.example");
      const button = screen.getByRole("button", { name: /^Connect$/ }) as HTMLButtonElement;
      expect(button.disabled).toBe(true); // the machine is in the disabled condition
      await clickConnect();
      expect(calls.filter((c) => c.url === "/api/ssh/launch")).toEqual([]);
      expect(screen.getByText("No SSH-enabled machine is available. Enable SSH on a machine first.")).toBeDefined();
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
      const caption = screen.getByText("Choose a connecting machine first.");
      expect(caption.className).toContain("text-amber-600"); // gold: nothing typed yet, not red
      expect(calls.filter((c) => c.url === "/api/ssh/launch")).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("destination field (contract 2)", () => {
  it("feeds the grouped rows: Saved, Recent, and the picked machine's config", async () => {
    const ledger = {
      saved: [
        {
          id: "s1",
          destination: "web01.example.com:22",
          alias: "web",
          nodeId: "a1",
          savedAt: "2026-10-01T00:00:00.000Z",
          lastConnectAt: "2026-10-05T00:00:00.000Z",
        },
      ],
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
      expect(within(popup).getByText("Saved")).toBeDefined();
      expect(within(popup).getByText("Recent")).toBeDefined();
      expect(within(popup).getByText("From mac mini's config")).toBeDefined();
      expect(within(popup).getByRole("button", { name: "web" })).toBeDefined();
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

  it("accepts a host typed that no list carries: the mirror row commits it", async () => {
    const { calls, restore } = await renderPanel({ nodes: [HOST_A] });
    try {
      await commitTyped("box.example");
      expect(destinationInput().value).toBe("box.example"); // the held echo is what will launch
      await clickConnect();
      const post = calls.find((c) => c.url === "/api/ssh/launch");
      expect(post?.body).toEqual({ node: "a1", destination: "box.example" });
    } finally {
      restore();
    }
  });

  it("a config-alias pick launches the token, and the save sends it as the alias", async () => {
    const { calls, restore } = await renderPanel({ nodes: [HOST_A], aliases: ["workbox"] });
    try {
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
      focusDestination();
      await settle();
      fireEvent.click(await screen.findByRole("button", { name: "workbox" }));
      await settle();
      fireEvent.click(screen.getByLabelText("Remember this destination"));
      await clickConnect();
      expect(calls.find((c) => c.url === "/api/ssh/launch")?.body).toEqual({ node: "a1", destination: "workbox" });
      await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/api/ssh/saved-hosts")).toBe(true));
      const put = calls.find((c) => c.method === "PUT" && c.url === "/api/ssh/saved-hosts");
      expect(put?.body).toEqual({ node: "a1", destination: "workbox", alias: "workbox" });
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
      if (url.pathname === "/api/nodes") return Promise.resolve(json({ nodes: [HOST_A] }));
      if (url.pathname === "/api/ssh/saved-hosts")
        return Promise.resolve(json({ saved: [], recent: [], defaultNodeId: null }));
      return Promise.resolve(json({}));
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({ getParentRoute: () => rootRoute, path: "/", component: ConnectPanel }),
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
      fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
      await settle();
      const button = screen.getByRole("button", { name: /Connecting/ }); // no spinner: the button owns the wait
      expect((button as HTMLButtonElement).disabled).toBe(true);
      release();
      await waitFor(() => expect(router.state.location.pathname).toBe("/subshells/s-9"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("Remember starts unchecked; a checked launch PUTs the saved row with no alias, unchecked PUTs nothing", async () => {
    const off = await renderPanel({ nodes: [HOST_A] });
    try {
      expect((screen.getByLabelText("Remember this destination") as HTMLInputElement).checked).toBe(false);
      await commitTyped("box.example");
      await clickConnect();
      await settle();
      expect(off.calls.filter((c) => c.method === "PUT" && c.url === "/api/ssh/saved-hosts")).toEqual([]);
    } finally {
      off.restore();
    }
    cleanup(); // one tree at a time
    const on = await renderPanel({ nodes: [HOST_A] });
    try {
      await commitTyped("box.example");
      fireEvent.click(screen.getByLabelText("Remember this destination"));
      await clickConnect();
      await waitFor(() =>
        expect(on.calls.some((c) => c.method === "PUT" && c.url === "/api/ssh/saved-hosts")).toBe(true),
      );
      const put = on.calls.find((c) => c.method === "PUT" && c.url === "/api/ssh/saved-hosts");
      expect(put?.body).toEqual({ node: "a1", destination: "box.example" });
    } finally {
      on.restore();
    }
  });

  it("Use by default PATCHes the connecting-machine preference", async () => {
    const { calls, restore } = await renderPanel({ nodes: [HOST_A] });
    try {
      await waitFor(() => expect(machineInput().value).toBe("mac mini"));
      fireEvent.click(screen.getByRole("button", { name: "Use by default" }));
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
          el?.tagName === "P" && (el.textContent ?? "").startsWith("Config needs settings Subshell does not run:"),
      );
      expect(line.className).toContain("text-destructive"); // a hard server refusal: red
      expect(line.textContent).toContain("Setting29"); // the WHOLE list, not the 200-char slice
      expect(line.textContent).toContain("Edit them on the connecting machine and retry.");
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
      expect(
        await screen.findByText("mac mini has no live connection right now. Bring its Subshell app online and retry."),
      ).toBeDefined();
    } finally {
      restore();
    }
  });

  it("ships the two-sentence disclosure under the destination field, wired as its description", async () => {
    const { restore } = await renderPanel({ nodes: [HOST_A] });
    try {
      const line = await screen.findByText(SSH_DISCLOSURE_COPY);
      expect(line.className).toContain("text-detail");
      expect(destinationInput().getAttribute("aria-describedby")).toBe("connect-destination-disclosure");
      // The exact sentences (decision 6), dash-free.
      expect(SSH_DISCLOSURE_COPY).toBe(
        "Resolving asks the connecting machine to read its SSH config. A hidden Match exec in that config can run a local command while it resolves.",
      );
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

describe("relay launch and approval recovery", () => {
  it("sends the selected key machine and preserves the returned connection choices", async () => {
    const { calls, restore } = await renderPanel(
      { nodes: [HOST_A, HOST_C] },
      { node: HOST_A.id, keyHome: HOST_C.id, destination: "theo@build.example.com:2222" },
    );
    try {
      await clickConnect();
      expect(calls.find((c) => c.url === "/api/ssh/launch")?.body).toEqual({
        node: HOST_A.id,
        keyHome: HOST_C.id,
        destination: "theo@build.example.com:2222",
      });
    } finally {
      restore();
    }
  });
  it("offers approval instead of incorrectly reporting the connecting machine offline", async () => {
    const { restore } = await renderPanel(
      {
        nodes: [HOST_A, HOST_C],
        launch: () =>
          json(
            { code: "SSH_GRANT_APPROVAL_REQUIRED", message: "Approve first.", metadata: { requestId: "req1" } },
            409,
          ),
      },
      { node: HOST_A.id, keyHome: HOST_C.id, destination: "work" },
    );
    try {
      await clickConnect();
      const link = screen.getByRole("link", { name: "Review SSH approval" }) as HTMLAnchorElement;
      expect(new URL(link.href).searchParams.get("requestId")).toBe("req1");
      expect(link.href).toContain("/settings/ssh");
      expect(link.href).toContain("keyHome");
      expect(screen.queryByText(/has no live connection/)).toBeNull();
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
      expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/selected key machine is unavailable/)).toBeTruthy();
      expect(calls.some((c) => c.url === "/api/ssh/launch")).toBe(false);
    } finally {
      restore();
    }
  });
});
