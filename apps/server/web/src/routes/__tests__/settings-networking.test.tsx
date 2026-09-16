import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NETWORK_STATE_LEGEND } from "@/components/setup/network-row";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { awaitingLogin, Route } from "@/routes/settings_.networking";
import type { NetworkRow, NetworkStatus } from "@/types/network";

/**
 * Server Settings → Networking.
 *
 * The page itself is thin — a gate, a list, and one card that offers what
 * this build ships — so these tests are about the gate and the composition.
 * What a row can DO is the card's own suite
 * (`components/__tests__/network-plugin-card.test.tsx`).
 */

interface PageFixture {
  admin: boolean;
  networks?: NetworkRow[];
  /** What GET /api/plugins answers — the "Add a network" card's source */
  plugins?: unknown[];
  /** Fail GET /api/network with this status */
  failStatus?: number;
}

function network(over: Partial<NetworkRow> & { id: string; name: string }): NetworkRow {
  return {
    description: "",
    exposure: "private",
    labels: {},
    platforms: ["darwin", "linux"],
    supported: true,
    enabled: true,
    interactiveLogin: true,
    publishImplicit: false,
    privileged: [],
    settingsFields: [],
    settings: {},
    published: false,
    status: { state: "needs-login", addresses: [], hints: [] },
    ...over,
  };
}

interface Call {
  method: string;
  pathname: string;
  body?: string;
}

function mockServer(fx: PageFixture) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, pathname: url.pathname, body: init?.body as string | undefined });
    const json = (obj: unknown) => Promise.resolve(new Response(JSON.stringify(obj)));
    if (url.pathname === "/api/settings/public") {
      return json({
        allowRegistrations: false,
        emergencyLoginActive: false,
        instanceName: "test",
        appBaseUrl: "http://localhost:3080",
        viewerIsAdmin: fx.admin,
        serverVersion: "1.6.0",
      });
    }
    if (url.pathname === "/api/network") {
      if (fx.failStatus) {
        return Promise.resolve(new Response(JSON.stringify({ message: "nope" }), { status: fx.failStatus }));
      }
      return json({ networks: fx.networks ?? [] });
    }
    if (url.pathname === "/api/plugins") return json({ plugins: fx.plugins ?? [] });
    return json({});
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <ConfirmProvider>
        <Outlet />
      </ConfirmProvider>
    ),
  });
  const page = Route.update({
    id: "/settings_/networking",
    path: "/settings/networking",
    getParentRoute: () => rootRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/settings/networking"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("the networking page", () => {
  it("lists one collapsed row per network for an admin, and Configure opens the card", async () => {
    const m = mockServer({
      admin: true,
      networks: [network({ id: "tailscale", name: "Tailscale" }), network({ id: "netbird", name: "NetBird" })],
    });
    try {
      renderPage();
      // Rows, not cards: the list names each network and answers for itself;
      // no card chrome exists until a press.
      expect(await screen.findByRole("listitem", { name: "Tailscale" })).toBeTruthy();
      expect(screen.getByRole("listitem", { name: "NetBird" })).toBeTruthy();
      // The needs-login card's credential field is the body's own landmark:
      // the whole card, not the wizard's stripped frame.
      expect(screen.queryByText("Access key")).toBeNull();
      // Scoped: both rows offer Configure, and the press belongs to ONE.
      const row = screen.getByRole("listitem", { name: "Tailscale" });
      fireEvent.click(within(row).getByRole("button", { name: "Configure" }));
      expect(await within(row).findByText("Access key")).toBeTruthy();
      // One press opens ONE card.
      expect(within(screen.getByRole("listitem", { name: "NetBird" })).queryByText("Access key")).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("defines the two chips above the rows, in the wizard's words", async () => {
    // "Joined" and "Published" look like synonyms for a status colour and are
    // not — one of them is the difference between a dashboard that opens over
    // the network and one that 403s on sign-in. The sentence belongs to
    // `network-row.tsx`, which owns the chips, so this asserts the shared
    // constant rather than retyping it: a second definition would be a second
    // sentence to drift from the wizard's.
    const m = mockServer({ admin: true, networks: [network({ id: "tailscale", name: "Tailscale" })] });
    try {
      renderPage();
      expect(await screen.findByText(NETWORK_STATE_LEGEND)).toBeTruthy();
    } finally {
      m.restore();
    }
  });

  it("explains nothing when there is no chip to explain", async () => {
    const m = mockServer({ admin: true, networks: [] });
    try {
      renderPage();
      // Settled rather than merely mounted: an unanswered read has no rows
      // either, so a legend absent at t=0 would prove nothing. The list
      // answering with NOTHING is the case being asserted.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(m.calls.some((c) => c.pathname === "/api/network")).toBe(true);
      expect(screen.queryByText(NETWORK_STATE_LEGEND)).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("shows a member nothing and asks the server for nothing", async () => {
    // Every route in this group 403s a member, the READ included — so an
    // `enabled`-gated query is the difference between a quiet page and a
    // doomed request on every mount.
    const m = mockServer({ admin: false, networks: [network({ id: "tailscale", name: "Tailscale" })] });
    try {
      renderPage();
      expect(await screen.findByText(/Networking is for instance admins/)).toBeTruthy();
      expect(screen.queryByRole("group", { name: "Tailscale" })).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(m.calls.some((c) => c.pathname === "/api/network")).toBe(false);
    } finally {
      m.restore();
    }
  });

  it("offers a Retry when the read fails, and nothing else pretends to work", async () => {
    const m = mockServer({ admin: true, failStatus: 500 });
    try {
      renderPage();
      expect(await screen.findByText(/Could not load this server's networks/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      m.restore();
    }
  });

  it("offers the networks this build ships that the instance has not installed", async () => {
    const m = mockServer({
      admin: true,
      plugins: [
        {
          id: "netbird",
          name: "NetBird",
          description: "",
          installed: false,
          enabled: true,
          builtIn: true,
          type: "network",
        },
        // Neither of these belongs on this page: one is already in the store,
        // the other is not a network at all.
        {
          id: "tailscale",
          name: "Tailscale",
          description: "",
          installed: true,
          enabled: true,
          builtIn: true,
          type: "network",
        },
        {
          id: "claude-code",
          name: "Claude Code",
          description: "",
          installed: false,
          enabled: true,
          builtIn: true,
          type: "agent-harness",
        },
      ],
    });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Install NetBird" }));
      await waitFor(() => expect(m.calls.some((c) => c.method === "POST" && c.pathname === "/api/plugins")).toBe(true));
      expect(screen.queryByRole("button", { name: "Install Claude Code" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Install Tailscale" })).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("says nothing about adding a network when there is nothing to add", async () => {
    const m = mockServer({ admin: true, plugins: [] });
    try {
      renderPage();
      await screen.findByText("Networking");
      expect(screen.queryByText("Add a network")).toBeNull();
    } finally {
      m.restore();
    }
  });
});

describe("awaitingLogin: what makes this page poll a CLI every five seconds", () => {
  const withStatus = (over: Partial<NetworkStatus>): NetworkRow =>
    network({
      id: "tailscale",
      name: "Tailscale",
      status: { state: "needs-login", addresses: [], hints: [], ...over },
    });

  it("is false for a row merely resting in needs-login", () => {
    // `needs-login` is the RESTING state of any installed, running, unjoined
    // network. Keying on it made an admin who opened this page with Tailscale
    // installed and not signed in run `tailscale status --json` every five
    // seconds for as long as the tab stayed open, for a row nobody was acting
    // on. Nothing else pins this, so a revert to the state test is silent.
    expect(awaitingLogin([withStatus({})])).toBe(false);
  });

  it("is true only once an interactive login has actually started", () => {
    // A login URL exists only while a sign-in is pending, and it is the one
    // case where the answer arrives out of band — on another device — so
    // polling is the only way this page learns.
    expect(awaitingLogin([withStatus({ loginUrl: "https://login.example/a" })])).toBe(true);
  });

  it("is false for an empty or unanswered list", () => {
    expect(awaitingLogin([])).toBe(false);
    expect(awaitingLogin(undefined)).toBe(false);
  });
});
