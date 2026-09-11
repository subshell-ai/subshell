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
import type { HarnessInfo } from "@/types/harness";

/**
 * The setup wizard, driven the way a user drives it: register, walk the
 * steps, land somewhere real. The claim spec 2026-09-10 puts on this page is
 * that a clean machine — no agent CLI, nothing installed — comes out of the
 * wizard typing into a live pane, so these tests render the ROUTE (its
 * `useNavigate` and the shared-cache retirement are the subject, not plumbing)
 * against a memory router with a stub `/subshells/$id` leaf.
 */

// The fetch stub must exist BEFORE the app modules load: better-auth's client
// binds `fetch` at creation (module evaluation of @/lib/auth-client), so a
// mock swapped in after the import is invisible to it — the sign-up then hits
// the real network and the wizard shows "Network error". This delegating stub
// IS the global fetch for the file; per-test handlers just repoint `handler`.
// (Measured, 2026-09-10 — the first version of this file swapped
// globalThis.fetch per test, exactly like the other web suites do, and every
// registration in it failed.)
let handler: (input: unknown, init?: RequestInit) => Promise<Response> = () =>
  Promise.resolve(new Response(JSON.stringify({})));
const _originalFetch = globalThis.fetch;
globalThis.fetch = ((input: unknown, init?: RequestInit) => handler(input, init)) as typeof fetch;

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

const _TERMINAL_USABLE: HarnessInfo = {
  id: "terminal",
  name: "Terminal",
  binary: "bash",
  envOverride: "SHELL",
  description: "A plain shell",
  installed: true,
  installedHere: true,
  install: { command: "", docsUrl: "" },
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
  handler = (input, init) => {
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
  };
}

/** Flush pending query/mutation/effect updates inside act() (50 ms is
 *  generous for Promise.resolve-backed mocks; see the ffe50bc note in the
 *  new-subshell-form test). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** A node/profile pair the launch step's form can default onto. */
const _LAUNCH_NODE = {
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
  harnesses: [
    { harnessId: "terminal", name: "Terminal", enabled: true, installed: true },
    { harnessId: "claude-code", name: "Claude Code", enabled: false, installed: false },
  ],
  inventoryStale: false,
};

const _LAUNCH_PROFILE = {
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

afterEach(cleanup);

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
