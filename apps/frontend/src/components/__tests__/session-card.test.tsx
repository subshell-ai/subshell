import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionCard } from "@/components/session-card";
import type { Node } from "@/types/node";
import type { SessionView } from "@/types/session";

/**
 * The node pill + offline copy on the home cards (spec 2026-08-31 §6.6/§5.6):
 * a remote session names its node on the subtitle line, a vanished node says
 * "deleted node", and a node whose agent has no live connection replaces the
 * corner badge with "node unreachable" — superseding both `exited` and the
 * waiting chip, and with them the "no screen — session has exited" copy,
 * because an offline node makes the process state unobservable, not dead.
 */
function agent(overrides: Partial<Node> = {}): Node {
  return {
    id: "mac",
    name: "mac mini",
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: 1,
    access: "owner",
    canManage: true,
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    profileId: "p1",
    harnessId: "claude",
    nodeId: "local",
    nodeOffline: false,
    name: "session",
    nameLocked: false,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    notes: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    access: "owner",
    terminalReplayLines: null,
    ...overrides,
  };
}

function mockNodes(nodes: Node[]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes })));
    if (path === "/api/profiles") return Promise.resolve(new Response(JSON.stringify([])));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

// SessionCard renders a `<Link>` (router context) and a menu (react-query) —
// the same minimal memory-router wrapper the local-launch-card test uses.
function renderCard(session: SessionView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SessionCard session={session} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("SessionCard node pill", () => {
  it("shows no pill for a local session", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSession());
      await screen.findByText("session");
      expect(screen.queryByText("mac mini")).toBeNull();
      expect(screen.queryByText("deleted node")).toBeNull();
    } finally {
      restore();
    }
  });

  it("names the node on a remote session's subtitle line", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSession({ nodeId: "mac" }));
      await screen.findByText("mac mini");
      expect(screen.queryByText("deleted node")).toBeNull();
    } finally {
      restore();
    }
  });

  it("says 'deleted node' for an id the registry no longer holds", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSession({ nodeId: "gone" }));
      await screen.findByText("deleted node");
    } finally {
      restore();
    }
  });
});

describe("SessionCard node-offline precedence", () => {
  it("replaces exited + the exit copy with the unreachable badge", async () => {
    const restore = mockNodes([agent({ status: "offline" })]);
    try {
      // The worst liar of the states: row says running, alive reads false
      // (the sweep's last-known truth) — all of it unobservable from here.
      renderCard(makeSession({ nodeId: "mac", nodeOffline: true, alive: false, exitCode: 1 }));
      await screen.findByText("node unreachable");
      expect(screen.queryByText("exited")).toBeNull();
      expect(screen.queryByText(/no screen — session has exited/)).toBeNull();
      expect(screen.queryByText(/exit: /)).toBeNull();
      expect(screen.getByText(/no screen — the node is offline/)).toBeDefined();
      // Identity survives: the pill still names the node.
      expect(screen.getByText("mac mini")).toBeDefined();
      // And the badge appears exactly once (corner only).
      expect(screen.getAllByText("node unreachable").length).toBe(1);
    } finally {
      restore();
    }
  });

  it("keeps the plain exited state untouched for local sessions", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSession({ alive: false, exitCode: 2 }));
      await screen.findByText("exited");
      expect(screen.getByText(/no screen — session has exited/)).toBeDefined();
      expect(screen.getByText(/exit: 2/)).toBeDefined();
      expect(screen.queryByText("node unreachable")).toBeNull();
    } finally {
      restore();
    }
  });
});
