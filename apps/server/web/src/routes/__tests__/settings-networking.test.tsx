import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { deploymentView, setting } from "@/components/__tests__/helpers/deployment-view";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { awaitingLogin, Route } from "@/routes/settings_.networking";
import type { NetworkRow, NetworkStatus } from "@/types/network";
import type { ServerDeployment } from "@/types/server-deployment";

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
  /** Override GET /api/settings/public's appBaseUrl (the RUNNING base URL) */
  appBaseUrl?: string;
  /** Override the deployment view — its APP_BASE_URL entry is the SAVED one */
  deployment?: ServerDeployment;
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
        appBaseUrl: fx.appBaseUrl ?? "http://localhost:3080",
        viewerIsAdmin: fx.admin,
        serverVersion: "1.6.0",
      });
    }
    // The page mounts `useServerDeployment` for the saved base URL. A `{}`
    // for it is survivable (the page reads `settings?.`), but the pending-
    // half tests need the real shape, so it answers properly by default.
    if (url.pathname === "/api/admin/server") return json(fx.deployment ?? deploymentView());
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
      // The needs-login card's join-mode choice is the body's own landmark: the
      // whole card, not the wizard's stripped frame. (This was the "Access key"
      // label until the mode choice landed — the credential box is now the
      // second panel, absent until the person asks for it, so it marks nothing.)
      expect(screen.queryByRole("group", { name: "How to connect" })).toBeNull();
      // Scoped: both rows offer Configure, and the press belongs to ONE.
      const row = screen.getByRole("listitem", { name: "Tailscale" });
      fireEvent.click(within(row).getByRole("button", { name: "Configure" }));
      expect(await within(row).findByRole("button", { name: "Sign in with Tailscale" })).toBeTruthy();
      // One press opens ONE card.
      expect(
        within(screen.getByRole("listitem", { name: "NetBird" })).queryByRole("group", { name: "How to connect" }),
      ).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("names the running base URL and the network whose address it is", async () => {
    // Every card's publish can hand the base URL an address it might name,
    // so the page that lists the cards prints the answer and names which
    // network's address list contains it — stated where it can be seen.
    const tailnet = "http://box.tail1234.ts.net:3080";
    const m = mockServer({
      admin: true,
      appBaseUrl: tailnet,
      // Saved EQUALS running — the no-pending case. Left at the helper's
      // localhost default it would disagree with the running tailnet URL and
      // correctly render the pending clause, failing the wrong assertion.
      deployment: deploymentView({ APP_BASE_URL: setting(tailnet) }),
      networks: [
        network({
          id: "tailscale",
          name: "Tailscale",
          status: {
            state: "published",
            addresses: [{ url: tailnet, scheme: "http", label: "MagicDNS", secureContext: false }],
            hints: [],
          },
        }),
      ],
    });
    try {
      renderPage();
      expect(await screen.findByText(/This server's address/)).toBeTruthy();
      expect(screen.getByText(/— over Tailscale/)).toBeTruthy();
      // Nothing saved-but-not-running, so no pending clause.
      expect(screen.queryByText(/Saved for the next restart/)).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("prints a saved base URL as pending the restart, not as the running one", async () => {
    // The constants are read at boot, so a fresh config write is SAVED, not
    // live — whichever page wrote it.
    // Showing it as the address would promise sign-in works over NetBird when
    // it does not yet; the line names the running one and flags the pending.
    const running = "http://box.tail1234.ts.net:3080";
    const pending = "http://nb.disaresta.internal:3080";
    const m = mockServer({
      admin: true,
      appBaseUrl: running,
      deployment: deploymentView({ APP_BASE_URL: { saved: pending, source: "config.env", running } }),
      networks: [
        network({
          id: "tailscale",
          name: "Tailscale",
          status: {
            state: "published",
            addresses: [{ url: running, scheme: "http", label: "MagicDNS", secureContext: false }],
            hints: [],
          },
        }),
        network({
          id: "netbird",
          name: "NetBird",
          status: {
            state: "joined",
            addresses: [{ url: pending, scheme: "http", label: "NetBird IP", secureContext: false }],
            hints: [],
          },
        }),
      ],
    });
    try {
      renderPage();
      expect(await screen.findByText(/This server's address/)).toBeTruthy();
      expect(screen.getByText(/Saved for the next restart/)).toBeTruthy();
      expect(screen.getByText(/— over NetBird/)).toBeTruthy();
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
