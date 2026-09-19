import { afterEach, describe, expect, it } from "bun:test";
import { MIN_NODE_VERSION, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setConfirmHandler } from "@/lib/confirm";
import { Route } from "@/routes/nodes_.$id";
import type { NodeDetail } from "@/types/node";

/**
 * The node detail page's manager affordances (spec 2026-08-31 §9/§10, card
 * gating per spec 2026-09-10): the harness card's Re-check (inside the card,
 * gated like the server's route on owner|edit, never on `local`), the
 * owner-only inline rename, the manager-only rotate-key flow with its
 * plaintext-once reveal, and the `node too old` chip. The page component is
 * rendered through the real route object (its `useParams` is strict), mounted
 * under a minimal memory router the way routeTree.gen wires it.
 */
function enrolledNode(overrides: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "node1",
    name: "box",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "box",
    status: "online",
    lastSeenAt: null,
    agentVersion: "0.1.0",
    protocolVersion: 1,
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
    held: null,
    ...overrides,
  };
}

/**
 * The control-plane host's own row — `kind: "local"`, which is what several
 * facts on this page branch on. Its own builder rather than an override on
 * {@link enrolledNode}, because a fixture called "enrolled" that is handed
 * `kind: "local"` says the opposite of what it builds.
 */
function localNode(overrides: Partial<NodeDetail> = {}): NodeDetail {
  return enrolledNode({ id: "local", kind: "local", ...overrides });
}

interface Call {
  method: string;
  url: string;
  body?: string;
}

function mockFetch(node: NodeDetail) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (url.pathname === `/api/nodes/${node.id}` && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(node)));
    }
    if (url.pathname === `/api/nodes/${node.id}/rotate-key` && method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ nodeKey: "subshell_new_secret", message: "re-config by hand" })),
      );
    }
    if (url.pathname === `/api/nodes/${node.id}` && method === "PATCH") {
      return Promise.resolve(new Response(JSON.stringify({ ...node, name: "renamed" })));
    }
    if (url.pathname === "/api/setup/harnesses" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify([])));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDetail(id: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const nodeRoute = Route.update({
    id: "/nodes_/$id",
    path: "/nodes/$id",
    getParentRoute: () => rootRoute,
  } as any);
  const router = createRouter({
    routeTree: rootRoute.addChildren([nodeRoute]),
    history: createMemoryHistory({ initialEntries: [`/nodes/${id}`] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("NodeDetailPage re-check gating", () => {
  // Re-check lives INSIDE the harness card now (spec 2026-09-10): the card is
  // detection output and Re-check is its one control. It gates on the
  // recheck route's OWN rule — `nodeCanConfigure` = owner|edit (security
  // context: "edit (or owner) additionally configures the node (re-checks)")
  // — so an `edit` grantee gets it even though `canManage` is false; hiding
  // it from them would strip a documented, server-honoured capability.
  // `local` never shows it: its probe is live on every read and recheck 400s.
  it("offers a `view` grantee no Re-check and POSTs nothing", async () => {
    const { calls, restore } = mockFetch(enrolledNode({ access: "view", canManage: false }));
    try {
      renderDetail("node1");
      await screen.findByText("Your access");
      expect(screen.queryByRole("button", { name: /Re-check/ })).toBeNull();
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/node1/recheck")).toBe(false);
    } finally {
      restore();
    }
  });

  it("offers an `edit` grantee a working Re-check despite not managing the node", async () => {
    const { calls, restore } = mockFetch(enrolledNode({ access: "edit", canManage: false }));
    try {
      renderDetail("node1");
      const btn = await screen.findByRole("button", { name: /Re-check/ });
      expect(btn.hasAttribute("disabled")).toBe(false);
      fireEvent.click(btn);
      await waitFor(() => {
        expect(calls.filter((c) => c.method === "POST" && c.url === "/api/nodes/node1/recheck")).toHaveLength(1);
      });
      // Configure yes, manage no: Share/Delete stay gated on `canManage`.
      expect(screen.getByRole("button", { name: /Share/ }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("button", { name: /Delete/ }).hasAttribute("disabled")).toBe(true);
    } finally {
      restore();
    }
  });

  it("offers the owner a working Re-check that POSTs once", async () => {
    const { calls, restore } = mockFetch(enrolledNode());
    try {
      renderDetail("node1");
      const btn = await screen.findByRole("button", { name: /Re-check/ });
      expect(btn.hasAttribute("disabled")).toBe(false);
      fireEvent.click(btn);
      await waitFor(() => {
        expect(calls.filter((c) => c.method === "POST" && c.url === "/api/nodes/node1/recheck")).toHaveLength(1);
      });
    } finally {
      restore();
    }
  });

  it("never offers Re-check on the local node (its probe is live on every read)", async () => {
    const { restore } = mockFetch(localNode({ access: "owner", canManage: true }));
    try {
      renderDetail("local");
      await screen.findByText("Your access");
      expect(screen.queryByRole("button", { name: /Re-check/ })).toBeNull();
    } finally {
      restore();
    }
  });

  /**
   * `local` runs no node daemon — the server drives it in-process, with no
   * socket and no enrollment — so the two facts a node REPORTS are
   * questions this row cannot be asked. They rendered a permanent "never" and
   * "—", which reads as a node in trouble rather than as a node that was never
   * going to answer.
   */
  it("omits the node-only facts on the local node, and keeps them on an enrolled node", async () => {
    const local = mockFetch(localNode({ access: "owner", canManage: true }));
    try {
      renderDetail("local");
      await screen.findByText("Your access");
      expect(screen.queryByText("Last seen")).toBeNull();
      expect(screen.queryByText("Node version")).toBeNull();
      // The facts that ARE true of this machine stay.
      expect(screen.getByText("Hostname")).toBeDefined();
      expect(screen.getByText("OS / arch")).toBeDefined();
    } finally {
      local.restore();
    }

    cleanup();

    const enrolled = mockFetch(enrolledNode());
    try {
      renderDetail("node1");
      await screen.findByText("Your access");
      expect(screen.getByText("Last seen")).toBeDefined();
      expect(screen.getByText("Node version")).toBeDefined();
    } finally {
      enrolled.restore();
    }
  });
});

describe("NodeDetailPage rename (owner-only PATCH)", () => {
  it("offers the inline editor to an enrolled node's owner and PATCHes the name on Enter", async () => {
    const { calls, restore } = mockFetch(enrolledNode());
    try {
      renderDetail("node1");
      const btn = await screen.findByRole("button", { name: "Rename node" });
      fireEvent.click(btn);
      const input = screen.getByRole("textbox", { name: "Rename node" }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/nodes/node1");
        expect(JSON.parse(patch?.body ?? "{}")).toEqual({ name: "renamed" });
      });
    } finally {
      restore();
    }
  });

  it("renders the editor for `local` when the viewer manages it (an admin)", async () => {
    // The control-plane host's row used to be unrenameable for everyone, which
    // left "Local" reading as the viewer's own machine (spec 2026-09-08). Its
    // `canManage` resolves to admin server-side, so that is the whole gate.
    const { restore } = mockFetch(localNode({ canManage: true }));
    try {
      renderDetail("local");
      await screen.findByText("Your access");
      expect(screen.queryByRole("button", { name: "Rename node" })).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("does not render the editor for `local` when the viewer does not manage it", async () => {
    const { restore } = mockFetch(localNode({ access: "edit", canManage: false }));
    try {
      renderDetail("local");
      await screen.findByText("Your access");
      expect(screen.queryByRole("button", { name: "Rename node" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("never renders the editor for a non-manager (the route 403s them too)", async () => {
    const { restore } = mockFetch(enrolledNode({ access: "edit", canManage: false }));
    try {
      renderDetail("node1");
      await screen.findByText("Your access");
      expect(screen.queryByRole("button", { name: "Rename node" })).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("NodeDetailPage rotate-key", () => {
  afterEach(() => setConfirmHandler(null));

  it("confirms, POSTs once, and reveals the plaintext key (shown-once card)", async () => {
    setConfirmHandler(() => Promise.resolve(true));
    const { calls, restore } = mockFetch(enrolledNode());
    try {
      renderDetail("node1");
      fireEvent.click(await screen.findByRole("button", { name: /Rotate key/ }));
      await waitFor(() => {
        expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/node1/rotate-key")).toBe(true);
      });
      // POST exactly once — the reveal must not re-fire the rotation.
      expect(calls.filter((c) => c.method === "POST" && c.url === "/api/nodes/node1/rotate-key").length).toBe(1);
      const revealed = await screen.findByText("subshell_new_secret");
      expect(revealed.textContent).toBe("subshell_new_secret");
      expect(screen.getByText(/shown once/i)).toBeDefined();
      // Done retires the plaintext from the DOM.
      fireEvent.click(screen.getByRole("button", { name: /Done, hide the key/ }));
      await waitFor(() => expect(screen.queryByText("subshell_new_secret")).toBeNull());
    } finally {
      restore();
    }
  });

  it("does not POST when the confirm is declined", async () => {
    let confirmAnswered = false;
    setConfirmHandler(() =>
      Promise.resolve(false).then((ok) => {
        confirmAnswered = true;
        return ok;
      }),
    );
    const { calls, restore } = mockFetch(enrolledNode());
    try {
      renderDetail("node1");
      fireEvent.click(await screen.findByRole("button", { name: /Rotate key/ }));
      // Gate on the decline having actually been processed instead of a fixed
      // sleep: `rotateKey` continues in the microtask right after this promise
      // settles, so if a rogue POST were fired it would be recorded before
      // waitFor's next poll (a macrotask) can observe `confirmAnswered`.
      await waitFor(() => expect(confirmAnswered).toBe(true));
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/node1/rotate-key")).toBe(false);
    } finally {
      restore();
    }
  });

  it("disables Rotate key for a non-manager", async () => {
    const { restore } = mockFetch(enrolledNode({ access: "edit", canManage: false }));
    try {
      renderDetail("node1");
      const btn = await screen.findByRole("button", { name: /Rotate key/ });
      expect(btn.hasAttribute("disabled")).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("NodeDetailPage protocol-mismatch chip", () => {
  it("chips an offline node whose reported protocol predates the control plane's", async () => {
    const { restore } = mockFetch(enrolledNode({ status: "offline", protocolVersion: 0 }));
    try {
      renderDetail("node1");
      await screen.findByText("Your access");
      expect(screen.getByText("node too old")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("stays silent for a current protocol", async () => {
    // Rides the constant, so a bump cannot leave this asserting a literal.
    const { restore } = mockFetch(enrolledNode({ status: "offline", protocolVersion: NODE_PROTOCOL_VERSION }));
    try {
      renderDetail("node1");
      await screen.findByText("Your access");
      expect(screen.queryByText("node too old")).toBeNull();
    } finally {
      restore();
    }
  });

  it("names a node AHEAD of the server, not just one behind it", async () => {
    // The protocol is matched exactly, so a node newer than the control
    // plane is refused too — and "offline" alone would send someone to
    // upgrade the node, which is the wrong end. There is no in-window case
    // any more: any mismatch is a deployment out of step.
    const { restore } = mockFetch(enrolledNode({ status: "offline", protocolVersion: NODE_PROTOCOL_VERSION + 1 }));
    try {
      renderDetail("node1");
      await screen.findByText("Your access");
      expect(screen.getByText("node too new")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("stays silent for a never-seen node (protocolVersion null)", async () => {
    const { restore } = mockFetch(enrolledNode({ status: "offline", protocolVersion: null }));
    try {
      renderDetail("node1");
      await screen.findByText("Your access");
      expect(screen.queryByText("node too old")).toBeNull();
    } finally {
      restore();
    }
  });

  it("stays silent while the node is still online", async () => {
    const { restore } = mockFetch(enrolledNode({ status: "online", protocolVersion: 0 }));
    try {
      renderDetail("node1");
      await screen.findByText("Your access");
      expect(screen.queryByText("node too old")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("NodeDetailPage node-version floor", () => {
  it("badges a node below MIN_NODE_VERSION, independently of the protocol chip", async () => {
    // The Status page lists such a node and links HERE. Before this badge the
    // link landed on a page showing no warning at all, because the only chip
    // keys off protocolVersion — which a floor-refused node may well match.
    const { restore } = mockFetch(enrolledNode({ agentVersion: "0.0.1", protocolVersion: NODE_PROTOCOL_VERSION }));
    try {
      renderDetail("node1");
      await waitFor(() => expect(screen.getByText(`below minimum (${MIN_NODE_VERSION})`)).toBeDefined());
    } finally {
      restore();
    }
  });

  it("does not badge a node that meets the floor", async () => {
    const { restore } = mockFetch(enrolledNode({ agentVersion: MIN_NODE_VERSION }));
    try {
      renderDetail("node1");
      await waitFor(() => expect(screen.getByText(MIN_NODE_VERSION)).toBeDefined());
      expect(screen.queryByText(/below minimum/)).toBeNull();
    } finally {
      restore();
    }
  });
});
