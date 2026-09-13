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
import { SubshellCard } from "@/components/subshell-card";
import type { Node } from "@/types/node";
import type { SubshellView } from "@/types/subshell";

/**
 * The node pill + offline copy on the home cards (spec 2026-08-31 §6.6/§5.6):
 * a remote subshell names its node on the subtitle line, a vanished node says
 * "deleted node", and a node whose agent has no live connection replaces the
 * corner badge with "node unreachable" — superseding both `exited` and the
 * waiting chip, and with them the "no screen (subshell has exited)" copy,
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

function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: "p1",
    harnessId: "claude",
    nodeId: "local",
    nodeOffline: false,
    name: "subshell",
    nameLocked: false,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
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
    ...overrides,
  };
}

function mockNodes(nodes: Node[]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes })));
    if (path === "/api/presets") return Promise.resolve(new Response(JSON.stringify([])));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

// SubshellCard renders a `<Link>` (router context) and a menu (react-query) —
// the same minimal memory-router wrapper the local-launch-card test uses.
function renderCard(subshell: SubshellView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SubshellCard subshell={subshell} />,
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

describe("SubshellCard node pill", () => {
  it("shows no pill for a local subshell", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSubshell());
      await screen.findByText("subshell");
      expect(screen.queryByText("mac mini")).toBeNull();
      expect(screen.queryByText("deleted node")).toBeNull();
    } finally {
      restore();
    }
  });

  it("names the node on a remote subshell's subtitle line", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSubshell({ nodeId: "mac" }));
      await screen.findByText("mac mini");
      expect(screen.queryByText("deleted node")).toBeNull();
    } finally {
      restore();
    }
  });

  it("says 'deleted node' for an id the registry no longer holds", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSubshell({ nodeId: "gone" }));
      await screen.findByText("deleted node");
    } finally {
      restore();
    }
  });

  it("shows the raw id, not 'deleted node', while the nodes query is in flight", async () => {
    // The cold `/`: /api/nodes never answers, freezing the in-flight window.
    // A remote card must not flash a deletion verdict the fetch hasn't earned.
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/nodes") return new Promise<Response>(() => {});
      if (path === "/api/presets") return Promise.resolve(new Response(JSON.stringify([])));
      return Promise.resolve(new Response(JSON.stringify({})));
    }) as typeof fetch;
    try {
      renderCard(makeSubshell({ nodeId: "mac" }));
      await screen.findByText("subshell");
      expect(screen.queryByText("deleted node")).toBeNull();
      expect(screen.getByText("mac")).toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("SubshellCard node-offline precedence", () => {
  it("replaces exited + the exit copy with the unreachable badge", async () => {
    const restore = mockNodes([agent({ status: "offline" })]);
    try {
      // The worst liar of the states: row says running, alive reads false
      // (the sweep's last-known truth) — all of it unobservable from here.
      renderCard(makeSubshell({ nodeId: "mac", nodeOffline: true, alive: false, exitCode: 1 }));
      await screen.findByText("node unreachable");
      expect(screen.queryByText("exited")).toBeNull();
      expect(screen.queryByText(/no screen \(subshell has exited\)/)).toBeNull();
      expect(screen.queryByText(/exit: /)).toBeNull();
      expect(screen.getByText(/no screen \(the node is offline\)/)).toBeDefined();
      // Identity survives: the pill still names the node.
      expect(screen.getByText("mac mini")).toBeDefined();
      // And the badge appears exactly once (corner only).
      expect(screen.getAllByText("node unreachable").length).toBe(1);
    } finally {
      restore();
    }
  });

  it("keeps the plain exited state untouched for local subshells", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSubshell({ alive: false, exitCode: 2 }));
      await screen.findByText("exited");
      expect(screen.getByText(/no screen \(subshell has exited\)/)).toBeDefined();
      expect(screen.getByText(/exit: 2/)).toBeDefined();
      expect(screen.queryByText("node unreachable")).toBeNull();
    } finally {
      restore();
    }
  });
});
