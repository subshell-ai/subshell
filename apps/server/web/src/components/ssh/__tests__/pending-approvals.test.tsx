import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PendingApprovals } from "@/components/ssh/pending-approvals";

/**
 * The first-use approval queue (spec 2026-10-08 §6.2): each card names the
 * asking pane, the connecting machine and the destination, and lets the
 * operator pick the grant's key set FROM the key home's live roster. The cap
 * is the load-bearing case: more than SSH_MAX_GRANT_FINGERPRINTS is a RED
 * hard error (a refused selection, not a silent truncation) and Approve stays
 * gated until the selection is legal. A pre-selection the roster no longer
 * carries is surfaced as a disabled row and never rides the approve POST (the
 * server validates shape, not roster membership; this screen is the fence).
 * The 24 h deadline renders localized, like the sibling house queue.
 */

const fp = (i: number) => `SHA256:${i.toString().padStart(43, "0")}`;
const PRE = fp(1);
const STALE = `SHA256:${"9".repeat(43)}`;

const REQUEST = {
  id: "req1",
  keyHomeNodeId: "nodeA",
  resolvedSelector: "build-1.example.com",
  requestedFingerprints: [PRE],
  paneId: "pane1",
  bNodeId: "nodeB",
  expiresAt: "2026-10-09T10:00:00Z",
  status: "pending",
  createdAt: "2026-10-08T10:00:00Z",
};

const ROSTER = Array.from({ length: 10 }, (_, i) => ({ fingerprint: fp(i + 1), comment: `key ${i + 1}` }));

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

interface StubOptions {
  /** Override the agent roster (the stale-key case: the roster no longer carries a pre-selected fingerprint) */
  identities?: { fingerprint: string; comment: string }[];
  /** Override the queued request (e.g. a requestedFingerprints entry missing from the roster) */
  request?: Partial<typeof REQUEST>;
}

function stubFetch(restore: (undo: () => void) => void, opts: StubOptions = {}): Sent[] {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  restore(() => {
    globalThis.fetch = original;
  });
  const request = { ...REQUEST, ...opts.request };
  const identities = opts.identities ?? ROSTER;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/ssh/grant-requests") {
      return new Response(JSON.stringify({ requests: [request] }), { status: 200 });
    }
    if (url.pathname === "/api/ssh/grant-requests/req1/identities") {
      return new Response(JSON.stringify({ identities }), { status: 200 });
    }
    if (url.pathname === "/api/ssh/grant-requests/req1/approve") {
      return new Response(JSON.stringify({ grant: { id: "g1" } }), { status: 200 });
    }
    if (url.pathname === "/api/ssh/grant-requests/req1/deny") {
      return new Response(JSON.stringify({ requestId: "req1" }), { status: 200 });
    }
    if (url.pathname === "/api/nodes") {
      return new Response(
        JSON.stringify({
          nodes: [
            { id: "nodeA", name: "vault" },
            { id: "nodeB", name: "desk" },
          ],
        }),
        {
          status: 200,
        },
      );
    }
    if (url.pathname === "/api/subshells") {
      return new Response(JSON.stringify([{ id: "pane1", name: "builder", status: "running" }]), { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return sent;
}

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restores.splice(0)) undo();
});

/** Renders the queue inside a throwaway router: the requester renders as a Link. */
function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <PendingApprovals />,
  });
  const subshellRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, subshellRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  void router.load();
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function renderWithRoster() {
  renderScreen();
  return screen.findAllByRole("checkbox");
}

describe("PendingApprovals", () => {
  it("names the requester, the connecting machine and the destination", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    expect(await screen.findByText("builder")).toBeDefined();
    expect(screen.getByText(/desk/)).toBeDefined();
    expect(screen.getByText(/build-1\.example\.com/)).toBeDefined();
  });

  it("shows the key home's roster with the request's pre-selection carried", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    const boxes = await renderWithRoster();
    expect(boxes.length).toBe(10);
    const pre = screen.getByRole("checkbox", { name: PRE });
    expect(pre.getAttribute("data-checked")).not.toBeNull();
  });

  it("surfaces a pre-selected key the agent no longer holds and never sends it", async () => {
    const sent = stubFetch(
      (undo) => {
        restores.push(undo);
      },
      {
        // The request pre-selected STALE, but the key home's live roster no longer carries it.
        request: { requestedFingerprints: [STALE, PRE] },
        identities: [
          { fingerprint: PRE, comment: "key 1" },
          { fingerprint: fp(2), comment: "key 2" },
        ],
      },
    );
    renderScreen();
    // The stale pre-selection is VISIBLE, as a disabled row that says what happened:
    // it can be neither seen past nor ticked back on.
    expect(await screen.findByText(STALE)).toBeDefined();
    expect(await screen.findByText(/No longer present in vault/)).toBeDefined();
    // The row's checkbox is visibly disabled (Base UI's data-disabled, the attribute its opacity style binds to).
    expect(screen.getByRole("checkbox", { name: STALE }).hasAttribute("data-disabled")).toBe(true);
    // And the approve body carries only the key the operator can actually see:
    // the server validates shape, not roster membership, so this screen is the fence.
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent.some((s) => s.path.endsWith("/approve"))).toBe(true));
    const approve = sent.find((s) => s.path.endsWith("/approve"));
    expect(approve?.body).toEqual({ fingerprints: [PRE] });
  });

  it("renders the 24 h deadline localized, like the sibling house queue", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    // Same precedent as pending-users-table: `new Date(...).toLocaleString()`.
    const stamp = "10/9/2026, 10:00:00 AM";
    const timeSpy = spyOn(Date.prototype, "toLocaleString").mockReturnValue(stamp);
    restores.push(() => timeSpy.mockRestore());
    renderScreen();
    const line = await screen.findByText(/^Expires/);
    expect(line.textContent).toContain(stamp);
    // The raw UTC ISO spelling must not remain on the card.
    expect(line.textContent).not.toContain("2026-10-09");
  });

  it("refuses an over-cap selection as a RED hard error and gates Approve", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    // One is already chosen (the pre-selection); check until the ninth lands.
    let boxes = await renderWithRoster();
    for (const box of boxes) {
      if (box.getAttribute("data-checked") === null) fireEvent.click(box);
      boxes = await screen.findAllByRole("checkbox");
      const chosen = boxes.filter((b) => b.getAttribute("data-checked") !== null).length;
      if (chosen > 8) break;
    }
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("8");
    expect(alert.className).toContain("text-destructive");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("approves the selected fingerprints with the typed name", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    const boxes = await renderWithRoster();
    // Choose a second key, then take it back off: the pre-selection stays alone.
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[1]);
    fireEvent.change(screen.getByLabelText("Grant name"), { target: { value: "prod keys" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent.some((s) => s.path.endsWith("/approve"))).toBe(true));
    const approve = sent.find((s) => s.path.endsWith("/approve"));
    expect(approve?.body).toEqual({ fingerprints: [PRE], name: "prod keys" });
  });

  it("denies with one click: a denial writes no grant and simply re-asks later", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(sent.some((s) => s.path.endsWith("/deny"))).toBe(true));
  });

  it("names the key home's silence as the reason and leaves the card standing", async () => {
    const original = globalThis.fetch;
    restores.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/ssh/grant-requests/req1/identities") {
        return new Response(JSON.stringify({ message: "The key home could not be reached" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/ssh/grant-requests") {
        return new Response(JSON.stringify({ requests: [REQUEST] }), { status: 200 });
      }
      if (url.pathname === "/api/nodes") {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      if (url.pathname === "/api/subshells") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unstubbed fetch: ${init?.method ?? "GET"} ${url.pathname}`);
    }) as typeof globalThis.fetch;
    renderScreen();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be reached");
    expect(screen.queryAllByRole("checkbox").length).toBe(0);
  });

  it("offers the explicit-pin way out for a HostKeyAlias destination", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    expect(await screen.findByText(/HostKeyAlias/)).toBeDefined();
  });
});

it("approval explains the required retry and provides a return path", async () => {
  stubFetch((undo) => restores.push(undo));
  await renderWithRoster();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByText(/original connection did not start/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Return to Connect" })).toBeTruthy();
});
