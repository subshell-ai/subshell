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
import { SubshellManagerTable } from "@/components/subshell-manager-table";
import type { SubshellView } from "@/types/subshell";

/** A full SubshellView with overridable fields — the fixture idiom from the
 *  sibling list/picker tests (existing-subshell-list.test.tsx). */
function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "id-1",
    profileId: "profile-1",
    harnessId: "claude",
    nodeId: "mac",
    nodeOffline: false,
    name: "subshell",
    nameLocked: false,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-08-30T00:00:00.000Z",
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
    ...overrides,
  };
}

/** An ISO timestamp `ms` in the past — far from any `relativeElapsed` bucket
 *  boundary so the rendered bucket is stable for the length of a test run. */
function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function mockFetch() {
  // The per-row actions menu runs a profiles query on mount; answer it (and
  // anything else) so nothing escapes to the real network.
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    return Promise.resolve(new Response(JSON.stringify(path.startsWith("/api/profiles") ? [] : {})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/**
 * The table renders a name `<Link>` to `/subshells/$id` and an actions menu
 * (react-query + `useNavigate`), so it renders as the index route of a
 * minimal memory router that also registers the link target — the wrapper
 * idiom of the subshell-card/subshell-actions-menu tests.
 */
async function renderTable(subshells: SubshellView[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SubshellManagerTable subshells={subshells} />,
  });
  const subshellRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/subshells/$id",
    component: () => <div />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, subshellRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The row's two time columns, by position: [last output, uptime]. */
function timeCells(subshellName: string): string[] {
  const row = screen.getByText(subshellName).closest("tr");
  const cells = Array.from(row?.querySelectorAll("td") ?? []);
  return [4, 5].map((i) => cells[i]?.textContent ?? "");
}

describe("SubshellManagerTable time columns (spec §5.6 nodeOffline posture)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    cleanup();
    restore?.();
    restore = undefined;
  });

  it("prints both times for an online running row (current behavior pinned)", async () => {
    restore = mockFetch();
    const live = makeSubshell({
      id: "live",
      name: "live-local",
      nodeId: "local",
      status: "running",
      alive: true,
      startedAt: agoIso(2 * HOUR),
      lastOutputAt: agoIso(5 * MINUTE),
    });
    await renderTable([live]);
    expect(timeCells("live-local")).toEqual(["5m ago", "2h"]);
    expect(screen.queryByText("node unreachable")).toBeNull();
  });

  it("asserts no liveness times on a nodeOffline row — both time cells render '—' beside 'node unreachable'", async () => {
    restore = mockFetch();
    // The lying row: the DB still says running+alive with fresh-looking
    // times, but with the agent down those are last-known facts (§5.6) —
    // next to a "node unreachable" status the row must not tick an uptime
    // or an "ago" at them. The table's idiom for "nothing assertive" is
    // its own existing "—".
    const ghost = makeSubshell({
      id: "ghost",
      name: "ghost-on-mac",
      nodeOffline: true,
      status: "running",
      alive: true,
      startedAt: agoIso(2 * HOUR),
      lastOutputAt: agoIso(5 * MINUTE),
    });
    await renderTable([ghost]);
    const [lastOutput, uptime] = timeCells("ghost-on-mac");
    expect(lastOutput).toBe("—");
    expect(uptime).toBe("—");
    // No elapsed-style text survives in either cell…
    expect(lastOutput).not.toMatch(/ago|just now|\d+[mhd]/);
    expect(uptime).not.toMatch(/ago|just now|\d+[mhd]/);
    // …while the one assertive signal — the status badge — is present.
    expect(screen.getByText("node unreachable")).toBeDefined();
  });

  it("keeps '—' semantics for an offline row with no timestamps at all", async () => {
    restore = mockFetch();
    const ghost = makeSubshell({ id: "g2", name: "ghost-null-times", nodeOffline: true });
    await renderTable([ghost]);
    expect(timeCells("ghost-null-times")).toEqual(["—", "—"]);
  });
});
