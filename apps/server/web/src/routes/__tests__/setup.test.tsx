import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setFetchRouter } from "@/test-setup";
import type { HarnessInfo } from "@/types/harness";

/**
 * The setup wizard, driven the way a user drives it: register, walk the
 * steps, land somewhere real. The claim spec 2026-09-10 puts on this page is
 * that a clean machine — no agent CLI, nothing installed — comes out of the
 * wizard typing into a live pane, so these tests render the ROUTE (its
 * `useNavigate` and the shared-cache retirement are the subject, not plumbing)
 * against a memory router with a stub `/subshells/$id` leaf.
 */

// better-auth's client binds `fetch` at CREATION (module evaluation of
// @/lib/auth-client), so a mock swapped in after the import is invisible to
// it — measured, 2026-09-10: a per-test `globalThis.fetch` swap made every
// registration hit the real network ("Network error"), AND which file saw
// that depended on which test file imported the client first, because
// `bun test` runs a package's files in ONE process. The delegating stub
// therefore lives in the test PRELOAD (see `setFetchRouter` there); this
// file routes it per test and clears it in afterEach — clearing matters just
// as much: launch-subshell-dialog's fixture deliberately lets fetch FAIL,
// and a stub that outlives this file turns that into passing-on-nonsense.
const { Route } = await import("@/routes/setup");

/** One not-installed harness row — what a clean machine actually lists. */
const CLAUDE_ABSENT: HarnessInfo = {
  id: "claude-code",
  name: "Claude Code",
  binary: "claude",
  envOverride: "CLAUDE_PATH",
  description: "Anthropic's coding agent",
  installed: false,
  reason: "not-on-path",
  installedHere: true,
  install: { command: "see the vendor's install docs", docsUrl: "https://code.claude.com/docs/en/setup" },
};

interface SetupMocks {
  /** What GET /api/setup/harnesses answers */
  harnesses?: HarnessInfo[];
  /** What GET /api/nodes answers (launch step) */
  nodes?: unknown[];
  /** What GET /api/profiles answers (launch step) */
  profiles?: unknown[];
  /** What GET /api/files/recent answers (launch step) */
  recent?: { paths: { path: string; label: string | null }[]; home: string | null };
  /** What POST /api/subshells answers; default is a created subshell */
  create?: { status: number; body: unknown };
}

function routeFetch(opts: SetupMocks): void {
  setFetchRouter((input, init) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/setup/status") return Promise.resolve(new Response(JSON.stringify({ needsSetup: true })));
    if (path === "/api/setup/harnesses") {
      return Promise.resolve(new Response(JSON.stringify(opts.harnesses ?? [CLAUDE_ABSENT])));
    }
    if (path === "/api/auth/sign-up/email") {
      return Promise.resolve(new Response(JSON.stringify({ user: { id: "u1", name: "Ada" } })));
    }
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes: opts.nodes ?? [] })));
    if (path === "/api/profiles") return Promise.resolve(new Response(JSON.stringify(opts.profiles ?? [])));
    if (path === "/api/files/recent") {
      return Promise.resolve(new Response(JSON.stringify(opts.recent ?? { paths: [], home: null })));
    }
    if (path === "/api/subshells" && method === "POST") {
      const res = opts.create ?? { status: 201, body: { id: "sub-1" } };
      return Promise.resolve(new Response(JSON.stringify(res.body), { status: res.status }));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  });
}

/** Flush pending query/mutation/effect updates inside act() (50 ms is
 *  generous for Promise.resolve-backed mocks; see the ffe50bc note in the
 *  new-subshell-form test). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/**
 * The node list the launch step fetches: `local` plus one online agent,
 * mirroring a real registry — the wizard's default pick must survive
 * `pickNodeDefault` with alternatives on the list, not just in a lonely
 * `[local]`. (With the single-node list these tests still passed; this is
 * fixture realism, not a bug fix.)
 */
const LAUNCH_NODE = {
  id: "local",
  name: "Server",
  kind: "local",
  os: null,
  arch: null,
  hostname: null,
  status: "online",
  lastSeenAt: null,
  agentVersion: null,
  protocolVersion: null,
  access: "owner",
  canManage: true,
  capabilities: [],
  harnesses: [{ harnessId: "terminal", name: "Terminal", enabled: true, installed: true }],
  inventoryStale: false,
};

const LAUNCH_AGENT = { ...LAUNCH_NODE, id: "agent-1", name: "Mac Studio", kind: "agent", harnesses: [] };

const LAUNCH_PROFILE = {
  id: "p-term",
  harnessId: "terminal",
  name: "Default",
  description: null,
  envJson: null,
  flagsJson: null,
  settingsJson: null,
  configIsolation: 0,
  restartOnExit: 0,
  isDefault: 1,
  nodeId: null,
};

/**
 * Renders the wizard and walks it to `upto`: 0 = account form,
 * 1 = agent step (through real registration against the stubbed auth),
 * 2 = launch step. The walk IS the test substrate — the point of this page
 * is the path through it.
 */
async function renderSetup(opts: SetupMocks, upto: 0 | 1 | 2) {
  routeFetch(opts);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute();
  const setupRoute = Route.update({ id: "/setup", path: "/setup", getParentRoute: () => rootRoute } as never);
  const subshellRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/subshells/$id",
    component: () => <div>subshell page</div>,
  });
  const history = createMemoryHistory({ initialEntries: ["/setup"] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([setupRoute, subshellRoute]),
    history,
    defaultPreload: false,
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
  if (upto >= 1) {
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    // Wait on real step-1 CONTENT (the harness row), not the button label:
    // "Creating account…" makes "Create admin account" vanish while the
    // sign-up promise is still in flight.
    await waitFor(() => expect(screen.getByText("Claude Code")).toBeTruthy());
  }
  if (upto >= 2) {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
  }
  return { client, history };
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
});

describe("setup wizard: the agent step is optional", () => {
  it("presents the agent step as optional and says what happens if you skip it", async () => {
    await renderSetup({}, 1);
    expect(screen.getByText(/Add an agent \(optional\)/)).toBeTruthy();
    expect(screen.getByText(/plain terminal/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish setup" })).toBeNull();
  });

  it("keeps the node escape hatch for a machine with nothing usable", async () => {
    await renderSetup({ harnesses: [CLAUDE_ABSENT] }, 1);
    expect(await screen.findByText(/register a Node/)).toBeTruthy();
  });
});

describe("setup wizard: the launch step", () => {
  /** The mocks a step-2 render needs: a real-shaped node list, one launchable profile, a home. */
  const LAUNCH_MOCKS: SetupMocks = {
    nodes: [LAUNCH_NODE, LAUNCH_AGENT],
    profiles: [LAUNCH_PROFILE],
    recent: { paths: [], home: "/home/ada" },
  };

  it("arrives filled in: Task 6's defaults make it submittable without input", async () => {
    await renderSetup(LAUNCH_MOCKS, 2);
    const start = screen.getByRole("button", { name: "Start my first subshell" }) as HTMLButtonElement;
    // Not just "eventually enabled" — the settle inside the walk means the
    // defaults have already composed; a regression in them fails HERE rather
    // than as a click that silently launches with blanks.
    expect(start.disabled).toBe(false);
    expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe("/home/ada");
  });

  it("launches a subshell and lands on it", async () => {
    const { history } = await renderSetup(LAUNCH_MOCKS, 2);
    fireEvent.click(screen.getByRole("button", { name: "Start my first subshell" }));
    // The final ROUTER LOCATION, not just a navigate call: the redirect
    // effect on this page fires when the setup-status cache flips, and an
    // effect-bounce to "/" after the launch would pass a call spy while
    // leaving the user on the dashboard.
    await waitFor(() => expect(history.location.pathname).toBe("/subshells/sub-1"));
  });

  it("retires the setup-status cache on launch, so the shell does not bounce back", async () => {
    const { client } = await renderSetup(LAUNCH_MOCKS, 2);
    fireEvent.click(screen.getByRole("button", { name: "Start my first subshell" }));
    await waitFor(() =>
      expect(client.getQueryData<{ needsSetup: boolean }>(["setup-status"])).toEqual({ needsSetup: false }),
    );
  });

  it("lets a user leave without launching, and still finishes setup", async () => {
    const { client, history } = await renderSetup(LAUNCH_MOCKS, 2);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(client.getQueryData<{ needsSetup: boolean }>(["setup-status"])).toEqual({ needsSetup: false });
    await waitFor(() => expect(history.location.pathname).toBe("/"));
  });

  it("reports a create failure without trapping the user", async () => {
    const { history } = await renderSetup(
      {
        ...LAUNCH_MOCKS,
        create: {
          status: 409,
          body: { errId: "e1", code: "NODE_OFFLINE", message: "The node is offline", statusCode: 409 },
        },
      },
      2,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start my first subshell" }));
    await waitFor(() => expect(screen.getByText(/offline/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(history.location.pathname).toBe("/setup");
  });
});
