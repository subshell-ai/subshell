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
import { cleanup, render, screen } from "@testing-library/react";
import { SubshellCard } from "@/components/subshell-card";
import type { SubshellView } from "@/types/subshell";

/**
 * The offline copy on the home cards (spec 2026-08-31 §5.6): a node whose
 * agent has no live connection lands the corner dot on "node unreachable" —
 * superseding `exited` and the waiting state, and with them the "no screen
 * (subshell has exited)" copy, because an offline node makes the process
 * state unobservable, not dead. (The corner badge has been the shared status
 * dot since 2026-09-24 — accessible, so the state word is its name rather
 * than a rendered chip. The machine badge that used to sit on the subtitle
 * line left the same day: the tile grid's section header names it instead,
 * so these tests assert its ABSENCE.)
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
    unseenPush: false,
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
// the same minimal memory-router wrapper the node-maintenance-card test uses.
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

describe("SubshellCard carries no machine badge (2026-09-24)", () => {
  // The tile grid segments by machine now — the section header names it on
  // the sidebar's label ladder — so the card must NOT re-say it: a remote
  // card renders no node name and no deletion verdict, and it asks nothing
  // of the nodes registry.
  it("names no node on a remote subshell, resolved or not", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSubshell({ nodeId: "mac" }));
      await screen.findByRole("img", { name: "idle" });
      expect(screen.queryByText("mac mini")).toBeNull();
      expect(screen.queryByText("deleted node")).toBeNull();
      expect(screen.queryByText("gone")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("SubshellCard node-offline precedence", () => {
  it("replaces exited + the exit copy with the unreachable dot", async () => {
    const restore = mockNodes([agent({ status: "offline" })]);
    try {
      // The worst liar of the states: row says running, alive reads false
      // (the sweep's last-known truth) — all of it unobservable from here.
      renderCard(makeSubshell({ nodeId: "mac", nodeOffline: true, alive: false, exitCode: 1 }));
      // The corner badge is the shared status dot (2026-09-24): the state is
      // its accessible name, not a rendered word.
      await screen.findByRole("img", { name: "node unreachable" });
      expect(screen.queryByText("exited")).toBeNull();
      expect(screen.queryByText(/no screen \(subshell has exited\)/)).toBeNull();
      expect(screen.queryByText(/exit: /)).toBeNull();
      expect(screen.getByText(/no screen \(the node is offline\)/)).toBeDefined();
      // The machine is the GRID's section header now, not a badge on the
      // card: nothing here renders the node's name.
      expect(screen.queryByText("mac mini")).toBeNull();
      // And the offline dot appears exactly once (corner only).
      expect(screen.getAllByRole("img", { name: "node unreachable" }).length).toBe(1);
    } finally {
      restore();
    }
  });

  it("keeps the plain exited state untouched for local subshells", async () => {
    const restore = mockNodes([agent()]);
    try {
      renderCard(makeSubshell({ alive: false, exitCode: 2 }));
      await screen.findByRole("img", { name: "exited" });
      expect(screen.getByText(/no screen \(subshell has exited\)/)).toBeDefined();
      expect(screen.getByText(/exit: 2/)).toBeDefined();
      expect(screen.queryByRole("img", { name: "node unreachable" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("draws the shared dot beside the title, not a text badge (2026-09-24)", async () => {
    const restore = mockNodes([agent()]);
    try {
      // A running, waiting subshell: the state reads as the amber dot whose
      // accessible name is "waiting for you" — and NOTHING renders the words
      // as visible text (that was the chip this replaced).
      renderCard(
        makeSubshell({
          status: "running",
          alive: true,
          activity: "active",
          lastOutputAt: new Date().toISOString(),
          waitingSince: "2026-09-24T00:00:00.000Z",
        }),
      );
      await screen.findByRole("img", { name: "waiting for you" });
      expect(screen.queryByText("waiting for you")).toBeNull();
      expect(screen.queryByText("running")).toBeNull();
      expect(screen.queryByText("working")).toBeNull();
    } finally {
      restore();
    }
  });
});
