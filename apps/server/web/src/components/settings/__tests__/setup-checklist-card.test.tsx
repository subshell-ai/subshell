import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupChecklistCard } from "@/components/settings/setup-checklist-card";

/**
 * The "Finish setting up" card (spec 2026-09-15 § 5.2).
 *
 * The composition is `lib/setup-checklist.ts`'s and is tested there; what is
 * left for this file is everything the pure function cannot answer — the
 * admin gate, the three reads it is built from, the rule that an unanswered
 * read renders NOTHING rather than a wrong list, and the one remedy that is a
 * button rather than words.
 *
 * Every response is stubbed here: this suite must never reach a server.
 */

interface StubOpts {
  /** `GET /api/settings/public` → viewerIsAdmin */
  admin?: boolean;
  /** Resolved tmux path on the host, null = missing */
  tmuxPath?: string | null;
  /** Whether `GET /api/admin/server` ever answers (false models a read in flight) */
  deploymentAnswers?: boolean;
  /** service.enabled on the deployment view */
  serviceEnabled?: boolean | null;
  /** Detected agent harnesses on the control-plane host */
  agentInstalled?: boolean;
}

/** Calls the card made, so the gate can be asserted as an absence of requests. */
interface Call {
  method: string;
  url: string;
}

/**
 * `GET /api/admin/server`'s body — the whole view, because the autostart POST
 * answers with one too and the hook writes that answer straight into the
 * cache. A stub that answered the POST with only the field it changed made
 * the card render against half a view, which is a shape the server cannot
 * send.
 */
function deploymentBody(enabled: boolean | null): Record<string, unknown> {
  return {
    configEnv: { path: "/etc/subshell/config.env", exists: true },
    settings: {
      HOST: { saved: "0.0.0.0", source: "config.env", running: "0.0.0.0" },
      APP_BASE_URL: { saved: "http://box.local:3080", source: "config.env", running: "http://box.local:3080" },
      TRUSTED_ORIGINS: { saved: "", source: "default", running: "" },
    },
    service: { manager: "systemd", installed: true, enabled, linger: true },
    platform: "linux",
  };
}

function stub(opts: StubOpts = {}): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  const tmuxPath = opts.tmuxPath === undefined ? "/usr/bin/tmux" : opts.tmuxPath;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname });
    if (url.pathname === "/api/settings/public") {
      return Promise.resolve(Response.json({ viewerIsAdmin: opts.admin ?? true, instanceName: "box" }));
    }
    if (url.pathname === "/api/admin/status") {
      return Promise.resolve(
        Response.json({
          runtime: { tmuxPath },
          security: { usingPlaceholderSecret: false },
        }),
      );
    }
    if (url.pathname === "/api/admin/server" && method === "GET") {
      // A read that never answers: the card must render nothing rather than
      // a list assembled from the two facts it does have.
      if (opts.deploymentAnswers === false) return new Promise<Response>(() => {});
      return Promise.resolve(Response.json(deploymentBody(opts.serviceEnabled ?? true)));
    }
    if (url.pathname === "/api/admin/server/autostart" && method === "POST") {
      return Promise.resolve(Response.json(deploymentBody(true)));
    }
    if (url.pathname === "/api/setup/harnesses") {
      return Promise.resolve(
        Response.json([
          { id: "terminal", name: "Terminal", type: "terminal", installed: true },
          { id: "claude-code", name: "Claude Code", type: "agent-harness", installed: opts.agentInstalled ?? true },
        ]),
      );
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Mount the card under a router carrying the two routes its remedies link to. */
async function mount(): Promise<void> {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
      >
        <SetupChecklistCard />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/settings/service" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/nodes/$id" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

afterEach(cleanup);

describe("SetupChecklistCard", () => {
  it("renders nothing when the instance needs nothing", async () => {
    const { calls, restore } = stub();
    try {
      await mount();
      await waitFor(() => expect(calls.some((c) => c.url === "/api/admin/server")).toBe(true));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/setup/harnesses")).toBe(true));
      expect(screen.queryByText("Finish setting up")).toBeNull();
    } finally {
      restore();
    }
  });

  it("lists what is missing, with the consequence and the command", async () => {
    const { restore } = stub({ tmuxPath: null });
    try {
      await mount();
      expect(await screen.findByText("Finish setting up")).toBeDefined();
      expect(screen.getByText("Install tmux")).toBeDefined();
      expect(screen.getByText(/every subshell runs inside a tmux pane/i)).toBeDefined();
      expect(screen.getByText("sudo apt-get install -y tmux")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("renders nothing while a read it is built from is still in flight", async () => {
    // The facts it DOES hold say tmux is missing. Rendering that list now and
    // a longer one a moment later is the flash this rule exists to prevent.
    const { calls, restore } = stub({ tmuxPath: null, deploymentAnswers: false });
    try {
      await mount();
      await waitFor(() => expect(calls.some((c) => c.url === "/api/admin/status")).toBe(true));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/setup/harnesses")).toBe(true));
      expect(screen.queryByText("Install tmux")).toBeNull();
      expect(screen.queryByText("Finish setting up")).toBeNull();
    } finally {
      restore();
    }
  });

  it("shows a non-admin nothing, and asks the admin endpoints nothing", async () => {
    const { calls, restore } = stub({ admin: false, tmuxPath: null });
    try {
      await mount();
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/public")).toBe(true));
      expect(screen.queryByText("Finish setting up")).toBeNull();
      expect(calls.some((c) => c.url === "/api/admin/status")).toBe(false);
      expect(calls.some((c) => c.url === "/api/admin/server")).toBe(false);
    } finally {
      restore();
    }
  });

  it("offers the autostart button when that is the supervision fix, and POSTs it", async () => {
    const { calls, restore } = stub({ serviceEnabled: false });
    try {
      await mount();
      const button = await screen.findByRole("button", { name: "Start automatically" });
      expect(screen.getByText("Start the server at login")).toBeDefined();
      fireEvent.click(button);
      await waitFor(() =>
        expect(calls.some((c) => c.method === "POST" && c.url === "/api/admin/server/autostart")).toBe(true),
      );
    } finally {
      restore();
    }
  });

  it("links a host with no agent CLI at its own node page", async () => {
    const { restore } = stub({ agentInstalled: false });
    try {
      await mount();
      const link = await screen.findByRole("link", { name: "This machine" });
      expect(link.getAttribute("href")).toBe("/nodes/local");
    } finally {
      restore();
    }
  });

  it("offers no way to dismiss it", async () => {
    // Deliberate: a checklist you can silence is a checklist that lies.
    const { restore } = stub({ tmuxPath: null });
    try {
      await mount();
      expect(await screen.findByText("Finish setting up")).toBeDefined();
      expect(screen.queryByRole("button", { name: /dismiss|hide|later/i })).toBeNull();
    } finally {
      restore();
    }
  });
});
