import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { resetDesktopShellForTests } from "@/lib/desktop";
import { CURRENT_USER_QUERY_KEY } from "@/lib/query-keys";
import { setFetchRouter } from "@/test-setup";
import type { HarnessInfo } from "@/types/harness";
import type { SetupStep } from "@/types/setup";

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
  type: "agent-harness",
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
  /** True = `GET /api/setup/harnesses` never settles (the agent step's UNKNOWN state). */
  harnessesPending?: boolean;
  /** True = `GET /api/setup/harnesses` answers 500 (the agent step's failed check). */
  harnessesError?: boolean;
  /** What GET /api/network answers (the Network step); default is no networks */
  networks?: unknown[];
  /**
   * True = `GET /api/network` never settles. The label tests need the UNKNOWN
   * state, and a never-resolving promise is this file's "still loading"
   * (same trick as `installPending`).
   */
  networkPending?: boolean;
  /** True = `GET /api/network` answers 500 (the Network step's failed check). */
  networkError?: boolean;
  /** What GET /api/nodes answers (launch step) */
  nodes?: unknown[];
  /** What GET /api/plugins answers (launch step — the Agent picker) */
  plugins?: unknown[];
  /** What GET /api/presets answers (launch step — hidden first run, still fetched) */
  presets?: unknown[];
  /** What GET /api/files/recent answers (launch step) */
  recent?: { paths: { path: string; label: string | null }[]; home: string | null };
  /** What POST /api/subshells answers; default is a created subshell */
  create?: { status: number; body: unknown };
  /** What POST /api/setup/agents/:id/install answers */
  install?: { status: number; body: unknown };
  /** True = the install POST never settles, so the mutation stays pending. */
  installPending?: boolean;
  /**
   * What GET /api/admin/status reports for `runtime.tmuxPath` — the Tmux
   * step's whole detection. `undefined` here means "found", since that is the
   * state of a host the wizard has nothing to say about.
   */
  tmuxPath?: string | null;
  /** What GET /api/admin/status reports for `runtime.os`, which decides the command shown. */
  os?: string;
  /** True = `GET /api/admin/status` never settles (the Tmux step's UNKNOWN state). */
  adminStatusPending?: boolean;
  /** True = `GET /api/admin/status` answers 500 (the Tmux step's failed check). */
  adminStatusError?: boolean;
  /** What POST /api/setup/tmux/install answers */
  tmuxInstall?: { status: number; body: unknown };
  /** True = the tmux install POST never settles, so the mutation stays pending. */
  tmuxInstallPending?: boolean;
  /**
   * What GET /api/setup/status reports. Default true (a first run) because
   * every pre-resume test walks the wizard from the account screen; the
   * resume tests set it false — an instance with an account, which is every
   * state a reopened wizard is ever in.
   */
  needsSetup?: boolean;
  /**
   * What GET /api/setup/progress answers — the caller's bookmark
   * (spec 2026-09-16). Default null: a user with no wizard in progress.
   */
  progressStep?: SetupStep | null;
}

/**
 * Bodies the stubbed better-auth sign-up endpoint received, in order.
 *
 * Module-level rather than per-render because `routeFetch` is the only place
 * that endpoint is answered; cleared in `afterEach` with the router itself.
 */
const signUpBodies: unknown[] = [];

/**
 * The `step` values PATCH /api/setup/progress received, in order — the
 * wizard's write-through, observable. Same module-level reason as
 * `signUpBodies`; cleared with it.
 */
const progressPatches: (SetupStep | null)[] = [];

function routeFetch(opts: SetupMocks): void {
  // Set once an install POST succeeds, so the following harness refetch (the
  // mutation's onSettled invalidation) reports the row as installed — the
  // way the real backend re-probes rather than replaying a fixed list.
  let installedId: string | null = null;
  /** Set once a tmux install succeeds — see the `/api/admin/status` branch. */
  let installedTmux: string | null = null;
  setFetchRouter((input, init) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/setup/status") {
      return Promise.resolve(new Response(JSON.stringify({ needsSetup: opts.needsSetup ?? true })));
    }
    if (path === "/api/setup/progress") {
      // The wizard's write-through: record what it asked to store, and answer
      // with what the real route answers — the step it just wrote.
      if (method === "PATCH") {
        const step = (JSON.parse(String(init?.body)) as { step: SetupStep | null }).step;
        progressPatches.push(step);
        return Promise.resolve(new Response(JSON.stringify({ step })));
      }
      return Promise.resolve(new Response(JSON.stringify({ step: opts.progressStep ?? null })));
    }
    if (path === "/api/setup/harnesses") {
      if (opts.harnessesPending) return new Promise<Response>(() => {});
      if (opts.harnessesError)
        return Promise.resolve(new Response(JSON.stringify({ message: "harness read failed" }), { status: 500 }));
      const base = opts.harnesses ?? [CLAUDE_ABSENT];
      const withInstall = installedId
        ? base.map((h) => (h.id === installedId ? { ...h, installed: true, version: "1.0.0", reason: undefined } : h))
        : base;
      return Promise.resolve(new Response(JSON.stringify(withInstall)));
    }
    if (path === "/api/auth/sign-up/email") {
      if (init?.body !== undefined) signUpBodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify({ user: { id: "u1", name: "Ada" } })));
    }
    if (path === "/api/admin/status") {
      if (opts.adminStatusPending) return new Promise<Response>(() => {});
      if (opts.adminStatusError)
        return Promise.resolve(new Response(JSON.stringify({ message: "status read failed" }), { status: 500 }));
      // Only the two fields the wizard reads. The real body is much wider and
      // has its own suite; mirroring it here would be a second fixture to keep
      // in step with a schema this page does not care about.
      const tmuxPath = installedTmux ?? (opts.tmuxPath === undefined ? "/usr/bin/tmux" : opts.tmuxPath);
      return Promise.resolve(new Response(JSON.stringify({ runtime: { tmuxPath, os: opts.os ?? "darwin" } })));
    }
    if (path === "/api/setup/tmux/install" && method === "POST") {
      // A real `brew install` takes a minute; a promise that never settles is
      // what "still installing" looks like to the component.
      if (opts.tmuxInstallPending) return new Promise<Response>(() => {});
      const res = opts.tmuxInstall ?? {
        status: 200,
        body: { ok: true, exitCode: 0, output: "done", durationMs: 12, tmuxPath: "/opt/homebrew/bin/tmux" },
      };
      // Same trick the agent installer's stub uses: a successful run changes
      // what the NEXT detection read answers, the way a re-probe would, rather
      // than replaying a fixed fact.
      if (res.status === 200) installedTmux = "/opt/homebrew/bin/tmux";
      return Promise.resolve(new Response(JSON.stringify(res.body), { status: res.status }));
    }
    if (path === "/api/network") {
      if (opts.networkPending) return new Promise<Response>(() => {});
      if (opts.networkError)
        return Promise.resolve(new Response(JSON.stringify({ message: "network read failed" }), { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify({ networks: opts.networks ?? [] })));
    }
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes: opts.nodes ?? [] })));
    if (path === "/api/plugins") return Promise.resolve(new Response(JSON.stringify({ plugins: opts.plugins ?? [] })));
    if (path === "/api/presets") return Promise.resolve(new Response(JSON.stringify(opts.presets ?? [])));
    if (path === "/api/subshells" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify([])));
    }
    if (path === "/api/files/recent") {
      return Promise.resolve(new Response(JSON.stringify(opts.recent ?? { paths: [], home: null })));
    }
    if (path === "/api/subshells" && method === "POST") {
      const res = opts.create ?? { status: 201, body: { id: "sub-1" } };
      return Promise.resolve(new Response(JSON.stringify(res.body), { status: res.status }));
    }
    if (path.startsWith("/api/setup/agents/") && path.endsWith("/install") && method === "POST") {
      // A real `curl … | bash` takes tens of seconds; a promise that never
      // settles is what "still installing" looks like to the component.
      if (opts.installPending) return new Promise<Response>(() => {});
      const id = path.slice("/api/setup/agents/".length, -"/install".length);
      const res = opts.install ?? {
        status: 200,
        body: {
          ok: true,
          exitCode: 0,
          output: "done",
          harness: { ...CLAUDE_ABSENT, installed: true, version: "1.0.0", reason: undefined },
        },
      };
      if (res.status === 200) installedId = id;
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
  canLaunch: true,
  capabilities: [],
  harnesses: [{ harnessId: "terminal", name: "Terminal", enabled: true, installed: true }],
  inventoryStale: false,
};

const LAUNCH_AGENT = { ...LAUNCH_NODE, id: "agent-1", name: "Mac Studio", kind: "agent", harnesses: [] };

/** The clean-machine catalog the wizard's launch step sees: Terminal is the
 *  only usable agent (spec 2026-09-10 §6 — what makes a fresh box launchable). */
const LAUNCH_PLUGINS = [
  { id: "claude-code", name: "Claude Code", description: "", installed: false, enabled: true, builtIn: true },
  {
    id: "terminal",
    name: "Terminal",
    description: "",
    installed: true,
    enabled: true,
    builtIn: true,
    type: "terminal",
  },
];

/** The wizard's screens, in browser order. */
type WalkStep = "account" | "network" | "tmux" | "agent" | "launch";

/** The heading each screen renders inside its `SetupAssistant` frame. */
const STEP_HEADING: Record<WalkStep, string> = {
  account: "Create Your Account",
  network: "Connect a Network",
  tmux: "Install tmux",
  agent: "Add an Agent",
  launch: "Start Your First Subshell",
};

/** Whether the screen `step` is the one on screen right now. */
function onStep(step: WalkStep): boolean {
  return screen.queryAllByRole("heading", { name: STEP_HEADING[step] }).length > 0;
}

const SERVER_UA_LINUX = "Mozilla/5.0 SubshellDesktop/1.0.0 (linux; p=1)";
const SERVER_UA_MACOS = "Mozilla/5.0 SubshellDesktop/1.0.0 (macos; p=1)";

/**
 * Runs `fn` with `navigator.userAgent` replaced by a Subshell Server shell
 * marker, restoring the real one and the parsed-shell memo afterwards.
 *
 * The memo reset is on BOTH sides because `desktopShell()` caches on first
 * read: without the front one, a sibling test's UA would still be what
 * `isServerDesktop()` sees when this one starts.
 */
async function underUA<T>(userAgent: string, fn: () => Promise<T>): Promise<T> {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const prev = Object.getOwnPropertyDescriptor(nav, "userAgent");
  resetDesktopShellForTests();
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true });
  try {
    return await fn();
  } finally {
    if (prev) Object.defineProperty(nav, "userAgent", prev);
    else delete nav.userAgent;
    resetDesktopShellForTests();
  }
}

/**
 * Renders the wizard and walks it to `upto`. The walk IS the test substrate —
 * the point of this page is the path through it — and it follows the CONTINUE
 * buttons rather than counting screens: inside Subshell Server the same walk
 * meets a shorter list (the Tmux step is the assistant's), and pinning the
 * buttons is what lets one helper drive both shells.
 */
async function renderSetup(opts: SetupMocks, upto: WalkStep) {
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
  if (upto === "account") return { client, history };
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "correct-horse-battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
  // Wait on real step-2 CONTENT (the network screen's own heading), not the
  // button label: "Creating account…" makes "Create Account" vanish while
  // the sign-up promise is still in flight.
  await waitFor(() => expect(onStep("network")).toBe(true));
  // Click forward until the target renders. Three is the longest walk in a
  // browser (network → tmux → agent → launch); inside Subshell Server the
  // same target arrives sooner, and a walk that cannot arrive fails on the
  // wait below rather than clicking a vanished button forever.
  //
  // The press is whichever label the step's ONE primary carries (2026-09-18):
  // "Continue" where the step has something to continue with, "Skip for now"
  // where it has not. The walk follows the button, not the word — one of the
  // two is on screen on every optional step, and only one.
  for (let i = 0; i < 3 && !onStep(upto); i++) {
    const primary =
      screen.queryByRole("button", { name: "Continue" }) ?? screen.getByRole("button", { name: "Skip for now" });
    fireEvent.click(primary);
    await settle();
  }
  await waitFor(() => expect(onStep(upto)).toBe(true));
  return { client, history };
}

/**
 * Mounts the wizard at `/setup` WITHOUT walking registration — the resume
 * path. A signed-in first admin reopening the app lands here with a bookmark,
 * not through the account form, so the walk helper (which registers) cannot
 * reach this state. `opts.needsSetup` is what the server reports (false for a
 * resumed instance) and `opts.progressStep` the caller's own bookmark.
 */
async function renderResume(opts: SetupMocks) {
  // A resume presupposes a signed-in user, and the wizard gates its bookmark
  // read on one — so the shared current-user query must answer with a user.
  routeFetch(opts);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(CURRENT_USER_QUERY_KEY, { id: "u1", email: "ada@example.com", name: "Ada" });
  const rootRoute = createRootRoute();
  const setupRoute = Route.update({ id: "/setup", path: "/setup", getParentRoute: () => rootRoute } as never);
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <div>dashboard</div> });
  const history = createMemoryHistory({ initialEntries: ["/setup"] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([setupRoute, homeRoute]),
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
  return { client, history };
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
  signUpBodies.length = 0;
  progressPatches.length = 0;
});

/**
 * Resuming the wizard (spec 2026-09-16).
 *
 * The defect: the step lived only in React state, and the account is created
 * on the FIRST screen — so the server reported setup done and reopening the
 * app landed on the dashboard. The bookmark is the fix; these drive the
 * resumed landing, the write-through, and the visitor that must STILL bounce.
 */
describe("setup wizard: resume", () => {
  it("opens a resumed bookmark on its step instead of the account screen", async () => {
    // needsSetup false is the state the whole defect turns on — it used to
    // mean "bounce to /"; now a bookmark names where to reopen instead.
    await renderResume({ needsSetup: false, progressStep: "agent" });
    expect(await screen.findByText("Add an Agent")).toBeTruthy();
    // No bounce: still on /setup, not the dashboard.
    expect(screen.queryByText("dashboard")).toBeNull();
  });

  it("opens 'launch' on the launch step", async () => {
    const { history } = await renderResume({
      needsSetup: false,
      progressStep: "launch",
      nodes: [LAUNCH_NODE],
      plugins: LAUNCH_PLUGINS,
      recent: { paths: [], home: "/home/ada" },
    });
    expect(await screen.findByText("Start Your First Subshell")).toBeTruthy();
    expect(history.location.pathname).toBe("/setup");
  });

  it("bounces a signed-in visitor with NO bookmark to the dashboard", async () => {
    // The other half of the rule: `needsSetup === false` AND no bookmark IS a
    // visitor. Without this the wizard would trap anyone who finished.
    const { history } = await renderResume({ needsSetup: false, progressStep: null });
    await waitFor(() => expect(history.location.pathname).toBe("/"));
  });

  it("opens a 'tmux' bookmark on the Tmux step in a browser", async () => {
    await renderResume({ needsSetup: false, progressStep: "tmux" });
    expect(await screen.findByText("Install tmux")).toBeTruthy();
  });

  it("maps a 'tmux' bookmark to the Agent step inside Subshell Server", async () => {
    // The step does not exist in that shell — its native assistant shows its
    // own tmux screen — so the bookmark resolves FORWARD, not back to
    // Account: the Agent step is exactly where the person still has to go,
    // and restarting the wizard would silently undo their walk.
    await underUA(SERVER_UA_LINUX, async () => {
      await renderResume({ needsSetup: false, progressStep: "tmux" });
      expect(await screen.findByText("Add an Agent")).toBeTruthy();
      expect(screen.queryByText("Install tmux")).toBeNull();
      expect(screen.queryByText("dashboard")).toBeNull();
    });
  });

  it("Skip on the Network step writes the 'tmux' bookmark", async () => {
    await renderSetup({}, "network");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(progressPatches).toContain("tmux"));
  });

  it("Skip on the Network step writes 'agent' inside Subshell Server, where no Tmux step exists", async () => {
    // The write follows the ACTIVE list, not a hard-coded next: bookmarking
    // a step this shell cannot render would be bookmarking a redirect target
    // that can only ever resolve forward.
    await underUA(SERVER_UA_LINUX, async () => {
      await renderSetup({}, "network");
      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
      await waitFor(() => expect(progressPatches).toContain("agent"));
      expect(progressPatches).not.toContain("tmux");
    });
  });

  it("Continue on the Tmux step writes the 'agent' bookmark", async () => {
    await renderSetup({}, "tmux");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(progressPatches).toContain("agent"));
  });

  it("finishing on the last step clears the bookmark", async () => {
    await renderSetup(
      { nodes: [LAUNCH_NODE], plugins: LAUNCH_PLUGINS, recent: { paths: [], home: "/home/ada" } },
      "launch",
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(progressPatches).toContain(null));
  });
});

/**
 * First run is the one account-creation path that does NOT go through
 * `POST /api/users`, which trims the display name server-side — this screen
 * registers through better-auth, which stores what it is handed. So the
 * client-side `normalizeNewAccount` is the only thing standing between
 * `"  Ada  "` and a roster row with the spaces in it, and the wizard used to
 * send both fields raw while the Add user dialog trimmed them.
 */
describe("setup wizard: what registration submits", () => {
  it("trims the name and email, and leaves the password exactly as typed", async () => {
    await renderSetup({}, "account");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Ada  " } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: " ada@example.com " } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: " correct-horse-battery " } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: " correct-horse-battery " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
    await waitFor(() => expect(signUpBodies.length).toBe(1));
    expect(signUpBodies[0]).toMatchObject({
      name: "Ada",
      email: "ada@example.com",
      password: " correct-horse-battery ",
    });
  });
});

describe("setup wizard: the agent step is optional", () => {
  it("presents the agent step as optional and says what happens if you skip it", async () => {
    await renderSetup({}, "agent");
    expect(screen.getByText(/A plain terminal is always available/)).toBeTruthy();
    // The clean fixture has nothing installed, so the single primary IS the
    // skip — the label names what the press is (2026-09-18).
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("keeps the node escape hatch for a machine with nothing usable", async () => {
    await renderSetup({ harnesses: [CLAUDE_ABSENT] }, "agent");
    expect(await screen.findByText(/register a Node/)).toBeTruthy();
  });

  it("lists a detected agent with its version, and never lists the terminal plugin", async () => {
    await renderSetup(
      {
        harnesses: [
          { ...CLAUDE_ABSENT, installed: true, version: "1.0.0", reason: undefined },
          {
            id: "terminal",
            name: "Terminal",
            type: "terminal",
            binary: "bash",
            envOverride: "SHELL",
            description: "A plain shell in a subshell pane.",
            installed: true,
            installedHere: true,
            install: { command: "", docsUrl: "" },
          },
        ],
      },
      "agent",
    );
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain("Detected · v1.0.0");
    expect(screen.queryByRole("listitem", { name: "Terminal" })).toBeNull();
    // Nothing usable? hatch stays hidden once an agent is detected.
    expect(screen.queryByText(/register a Node/)).toBeNull();
  });

  // An install runs on this machine and takes tens of seconds. Continuing out
  // from under it abandoned its progress line and any failure on a screen
  // nobody could see any more (operator report, 2026-09-14).
  it("refuses to continue while an install is running, and says what it is waiting for", async () => {
    await renderSetup({ harnesses: [CLAUDE_ABSENT], installPending: true }, "agent");
    // Nothing installed yet — the primary is labelled "Skip for now", and the
    // install-in-flight rule holds it disabled exactly as it held "Continue".
    const primary = screen.getByRole("button", { name: "Skip for now" });
    expect(primary.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(primary.hasAttribute("disabled")).toBe(true));
    // The progress lives on the ROW, not beside the button: the bar carries
    // no status text at all (operator's call, 2026-09-14).
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain("Installing…");
  });

  it("installs an agent and flips the row to Detected — and the primary with it", async () => {
    await renderSetup({ harnesses: [CLAUDE_ABSENT] }, "agent");
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await settle();
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    await waitFor(() => expect(row.textContent).toContain("Detected · v1.0.0"));
    // The bar reads the SAME refetch the row does (2026-09-18): the machine
    // now has something to continue with, and the button starts saying so
    // without anyone leaving the screen.
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("labels the primary 'Continue' on a machine where an agent was detected", async () => {
    await renderSetup(
      { harnesses: [{ ...CLAUDE_ABSENT, installed: true, version: "1.0.0", reason: undefined }] },
      "agent",
    );
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("labels the primary 'Skip for now' while the check has not answered", async () => {
    // Unknown ⇒ skip (2026-09-18): an unanswered read may not claim there is
    // something to continue with — see `primaryLabel` in the route.
    await renderSetup({ harnessesPending: true }, "agent");
    expect(await screen.findByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("labels the primary 'Skip for now' when the check FAILS", async () => {
    // The failed direction of the same ruling (review, 2026-09-18): a 500 has
    // answered nothing to continue with, and skipping must work exactly when
    // the check cannot speak. (A poll that fails AFTER good data is the other
    // case, and TanStack keeps `data` — the label stays "Continue" on a
    // machine that really has an agent, which is the right verdict.)
    await renderSetup({ harnessesError: true }, "agent");
    expect(await screen.findByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

/**
 * The Tmux step (spec 2026-09-15 § 5.1, as amended 2026-09-17).
 *
 * The defect the FEATURE closes is that the browser wizard had no tmux screen
 * at all — it existed only in the native Subshell Server assistant, so a
 * headless install discovered that every launch fails, or never found out.
 * The defect the STEP closes is the row's: pinned above the agents, tmux read
 * as an agent named tmux, under a subtitle promising "A plain terminal is
 * always available with nothing to install". tmux is what every local pane
 * runs inside — its own screen says so in its own words.
 */
describe("setup wizard: the tmux step", () => {
  /**
   * The step body's labelled group. Synchronous by design: the walk into the
   * step settles the admin-status read that decides the verdict (the request
   * fires the moment Network mounts, one `settle()` before this is ever
   * called), and the one time it is not yet settled — mid-install — the
   * assertions below wrap it in `waitFor` themselves.
   */
  function tmuxBlock(): HTMLElement {
    return screen.getByRole("group", { name: "tmux" });
  }

  it("is its own screen, and reports a host that has tmux with the path it found", async () => {
    await renderSetup({}, "tmux");
    expect(screen.getByRole("heading", { name: "Install tmux" })).toBeTruthy();
    expect(tmuxBlock().textContent).toContain("Found at");
    expect(tmuxBlock().textContent).toContain("/usr/bin/tmux");
    // A settled fact says nothing more: no command to run, nothing to press.
    expect(within(tmuxBlock()).queryByRole("button", { name: "Install" })).toBeNull();
    // The gate stands open on the machine the body just confirmed: the press
    // is "Continue", enabled, and never the skip word (operator's ruling,
    // 2026-09-18 — same read the body shows decides whether it can fire).
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("keeps tmux out of the agent list", async () => {
    // The ruling the step exists for: the agent list is agents.
    await renderSetup({}, "agent");
    expect(screen.queryByRole("listitem", { name: "tmux" })).toBeNull();
    expect(screen.getByText(/A plain terminal is always available/)).toBeTruthy();
  });

  it("says what a missing tmux costs and gates Continue on it", async () => {
    await renderSetup({ tmuxPath: null }, "tmux");
    expect(tmuxBlock().textContent).toContain("Subshells cannot launch on this machine");
    // The 2026-09-18 ruling reverses § 5.1's non-block: the press stays
    // "Continue" and simply cannot fire until the read reports a path. No
    // skip word appears — walking past tmux was never a save, it only moved
    // the refusal to the launch step.
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    // Back is not gated — walking back is not walking past.
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false);
  });

  it("holds the gated Continue shut while the tmux check has not answered", async () => {
    // Unknown counts as NOT-PRESENT on this step (2026-09-18), the opposite
    // polarity from the optional steps' unknown-labels-as-skip: the gate is
    // "cannot proceed unless installed", so an in-flight read holds the press
    // disabled rather than renaming it.
    await renderSetup({ adminStatusPending: true }, "tmux");
    // The body's own unknown-state line — and no verdict group yet, because
    // "Checking…" renders no fieldset.
    expect(await screen.findByText("Checking this machine…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("gives a failed tmux check a Retry — a gate that cannot answer must not sit shut forever", async () => {
    // The defect the gate makes NEW (2026-09-18): an errored read means
    // `tmuxPath` never arrives, so a silent failure would be a permanently
    // dead Continue — the trap § 5.1 was written to avoid, in inverted form.
    // The body must answer with the same ErrorBanner + Retry the other steps
    // use, and the gate holds until that Retry lands.
    await renderSetup({ adminStatusError: true }, "tmux");
    expect(await screen.findByText("Couldn't check for tmux on this machine.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("installs tmux on macOS, flips the step to found, and opens the gate", async () => {
    await renderSetup({ tmuxPath: null, os: "darwin" }, "tmux");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(tmuxBlock()).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(tmuxBlock().textContent).toContain("Found at"));
    // The install landing refetches the same read the bar reads, so the gate
    // opens on its own — no leave-and-return (2026-09-18).
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
  });

  it("holds the primary while the tmux install runs, and shows the installer's line", async () => {
    // The 2026-09-14 rule, now on the screen that owns the tmux install: a
    // `brew install` taking a minute must not be walked out of in either
    // direction, or its progress line and any failure land unseen.
    await renderSetup({ tmuxPath: null, os: "darwin", tmuxInstallPending: true }, "tmux");
    const primary = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(within(tmuxBlock()).getByRole("button", { name: "Install" }));
    // Already disabled by the missing-tmux gate — what the install proves is
    // that BOTH rules hold during the run, and Back flips as the install's
    // own doing.
    await waitFor(() => expect(primary.hasAttribute("disabled")).toBe(true));
    expect(tmuxBlock().textContent).toContain("Starting the installer…");
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows the Linux command to copy and offers no button for it", async () => {
    // The server has no terminal to answer sudo's password prompt, so the
    // route 409s a privileged installer. A button here would always fail.
    await renderSetup({ tmuxPath: null, os: "linux" }, "tmux");
    expect(tmuxBlock().textContent).toContain("sudo apt-get install -y tmux");
    expect(within(tmuxBlock()).queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("reports a refused install without pretending tmux arrived", async () => {
    await renderSetup(
      {
        tmuxPath: null,
        os: "darwin",
        tmuxInstall: { status: 409, body: { message: "No supported package manager was found on this host." } },
      },
      "tmux",
    );
    fireEvent.click(within(tmuxBlock()).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(tmuxBlock().textContent).toContain("No supported package manager was found on this host."),
    );
    expect(tmuxBlock().textContent).not.toContain("Found at");
  });
});

/**
 * One `GET /api/network` row. Only the fields the step's own layout reads —
 * the card's state matrix has its own suite next door
 * (`components/__tests__/network-plugin-card.test.tsx`).
 */
function network(over: { id: string; name: string; state?: string; supported?: boolean }) {
  const state = over.state ?? "not-installed";
  return {
    id: over.id,
    name: over.name,
    description: `${over.name} network`,
    exposure: "private",
    labels: {},
    platforms: ["darwin", "linux"],
    supported: over.supported ?? true,
    enabled: true,
    interactiveLogin: true,
    privileged: [{ label: `Install ${over.name}`, command: `brew install ${over.id}` }],
    settingsFields: [],
    settings: {},
    // An unsupported network has no status to report: the server attaches one
    // only for a plugin this host can actually run.
    ...(over.supported === false ? {} : { status: { state, addresses: [], hints: [] } }),
    published: state === "published",
  };
}

/**
 * The Network step (second, optional).
 *
 * The defect it closes is the one `/settings/service` documents from the
 * other end: a fresh install trusts only its own loopback addresses, so the
 * first thing a person does after setup — open the dashboard on their phone —
 * fails at sign-in with an error naming nothing they could change. The moment
 * to offer a fix is before anyone has typed an address into a phone.
 */
describe("setup wizard: the Network step", () => {
  it("is optional, and skipping lands on the Tmux step", async () => {
    await renderSetup({}, "network");
    // The framing, not just the button: a step whose only offer is a page of
    // vendor setup instructions reads as a wall, and the way round it was
    // nothing but an unlabelled footer control. Step 3's subtitle already said
    // "now, or later in Settings" — this says the same, and names where.
    expect(await screen.findByText(/This step is optional; you can set it up later under/)).toBeTruthy();
    // The destination names itself in the control-label weight, not just in
    // words: the split the markup introduces is the emphasis being asked for.
    expect(screen.getByText("Settings → Networking").className).toContain("font-strong");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(screen.getByText("Install tmux")).toBeTruthy());
    // Skip means the NEXT screen, whatever this shell renders — in a browser
    // that is now the Tmux step; inside Subshell Server the Skip test in the
    // resume describe pins that it lands on Agent instead.
  });

  it("renders every network as a collapsed row with a state chip", async () => {
    await renderSetup(
      {
        networks: [
          network({ id: "later", name: "Later" }),
          network({ id: "tailscale", name: "Tailscale", state: "joined" }),
        ],
      },
      "network",
    );
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("listitem", { name: "Tailscale" }).textContent).toContain("Joined");
    expect(screen.getByRole("listitem", { name: "Later" }).textContent).toContain("Not installed");
    // Nothing is expanded, so the two sudo commands, the Docs links and the
    // Re-check button this step used to OPEN with are not on screen at all —
    // that was the whole defect: a step framed as optional led with a page of
    // instructions relative to nothing.
    expect(screen.queryByText(/brew install/)).toBeNull();
    expect(screen.queryByText("Other networks")).toBeNull();
  });

  it("sorts networks the machine already has first", async () => {
    await renderSetup(
      {
        networks: [
          network({ id: "later", name: "Later" }),
          network({ id: "tailscale", name: "Tailscale", state: "joined" }),
        ],
      },
      "network",
    );
    const rows = await screen.findAllByRole("listitem");
    // Still the layout decision, now as a sort rather than a grouping: a
    // network the machine has is a question a person can answer right now.
    expect(rows[0]?.getAttribute("aria-label")).toBe("Tailscale");
  });

  it("Configure expands the row to the card, and Hide folds it away", async () => {
    await renderSetup({ networks: [network({ id: "later", name: "Later" })] }, "network");
    const row = await screen.findByRole("listitem", { name: "Later" });
    const button = within(row).getByRole("button", { name: "Configure" });
    fireEvent.click(button);
    await waitFor(() => expect(row.textContent).toContain("brew install later"));
    // The label says what the button does NEXT, so a person can fold the
    // instructions away again.
    const hide = within(row).getByRole("button", { name: "Hide" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    await waitFor(() => expect(row.textContent).not.toContain("brew install later"));
  });

  it("offers Manage on a published row and nothing on an unsupported one", async () => {
    await renderSetup(
      {
        networks: [
          network({ id: "cloudflared", name: "Cloudflared", state: "published" }),
          network({ id: "netbird", name: "NetBird", supported: false }),
        ],
      },
      "network",
    );
    const published = await screen.findByRole("listitem", { name: "Cloudflared" });
    // A published network still owns unpublish and leave, so the row has
    // somewhere to go — it is just not "configure" any more.
    expect(within(published).getByRole("button", { name: "Manage" })).toBeTruthy();
    const unsupported = screen.getByRole("listitem", { name: "NetBird" });
    expect(unsupported.textContent).toContain("Not available on this platform");
    // There is nothing to configure from here and the chip already says why.
    expect(within(unsupported).queryByRole("button")).toBeNull();
  });

  it("says so plainly when this build ships no networks at all", async () => {
    await renderSetup({}, "network");
    expect(await screen.findByText(/ships no network plugins/)).toBeTruthy();
  });

  // The label change this whole suite predates (operator's call, 2026-09-18):
  // one primary button whose label states what the press IS. These pin the
  // flip in both directions — and that no step carries two skip affordances.

  it("says 'Skip for now' on the signed-out machine: installed is not joined", async () => {
    // The exact state from the operator's screenshot — three vendors installed
    // and waiting on a sign-in, one not installed at all. The rows LEAD the
    // sort (`hasStarted` still decides that), but none of them has joined, so
    // the step has nothing to continue with and the button says skip.
    await renderSetup(
      {
        networks: [
          network({ id: "headscale", name: "Headscale", state: "needs-login" }),
          network({ id: "netbird", name: "NetBird", state: "needs-login" }),
          network({ id: "tailscale", name: "Tailscale", state: "needs-login" }),
          network({ id: "cloudflared", name: "Cloudflare Tunnel", state: "not-installed" }),
        ],
      },
      "network",
    );
    const skips = await screen.findAllByRole("button", { name: "Skip for now" });
    // One button, not a ghost-plus-primary pair — the ghost is gone.
    expect(skips).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("says 'Continue' once a network is joined, and drops the skip label", async () => {
    await renderSetup({ networks: [network({ id: "tailscale", name: "Tailscale", state: "joined" })] }, "network");
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("counts a published network as something to continue with", async () => {
    await renderSetup(
      { networks: [network({ id: "cloudflared", name: "Cloudflared", state: "published" })] },
      "network",
    );
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("says 'Skip for now' while the network read has not answered", async () => {
    // Unknown ⇒ skip (2026-09-18): a failed or in-flight check must never
    // print "Continue" — skipping has to work exactly when the check cannot
    // speak. See `primaryLabel` in the route for why this is the OPPOSITE
    // polarity from `lib/node-enrollment.ts`.
    await renderSetup({ networkPending: true }, "network");
    expect(await screen.findByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("says 'Skip for now' when the network read FAILS", async () => {
    // The failed direction (review, 2026-09-18): the step's own ErrorBanner
    // and the button's word are one verdict — the check could not speak, so
    // the bar does not claim there is something to continue with.
    await renderSetup({ networkError: true }, "network");
    expect(await screen.findByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

describe("setup wizard: going back", () => {
  it("walks back agent → tmux → Network in a browser", async () => {
    // The frame has always had a Back slot; no screen passed one, so a person
    // who wanted another look at the network they had just skipped had no way
    // to it but restarting the wizard. The chain must stay unbroken through
    // the step inserted in 2026-09-17: Back walks the ACTIVE list, and it
    // still terminates at Network — never at the account form.
    await renderSetup({}, "agent");
    expect(screen.getByText("Add an Agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("Install tmux")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("Connect a Network")).toBeTruthy());
  });

  it("walks back from the agent step straight to Network inside Subshell Server", async () => {
    // The omitted step is absent from the BACK chain too — a Back to a screen
    // this shell refuses to render would be a button that does nothing.
    await underUA(SERVER_UA_LINUX, async () => {
      await renderSetup({}, "agent");
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => expect(screen.getByText("Connect a Network")).toBeTruthy());
    });
  });

  it("goes back from the launch step to the agent step", async () => {
    await renderSetup({}, "launch");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("Add an Agent")).toBeTruthy());
  });

  it("offers NO Back on the Network step, because the account behind it already exists", async () => {
    // The invariant this protects: step 0 advances only after `signUp`
    // SUCCEEDS, so the screen before Network is a Create Account form for an
    // account that has already been created. Offering Back there would walk a
    // person into a form that cannot work.
    await renderSetup({}, "network");
    expect(screen.getByText("Connect a Network")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("offers no Back on the account step, which is the first screen this program owns", async () => {
    await renderSetup({}, "account");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});

describe("setup wizard: the dot row counts its own steps on every shell", () => {
  afterEach(() => {
    resetDesktopShellForTests();
  });

  it("reads Step 4 of 5 under a plain browser UA", async () => {
    // Five screens in a browser now: Account, Network, Tmux, Agent, Launch
    // (the Tmux step split off the agent list on 2026-09-17). The walk stops
    // on the fourth.
    await renderSetup({}, "agent");
    expect(screen.getByText("Step 4 of 5")).toBeTruthy();
  });

  it("counts the Tmux step as the third of the five", async () => {
    await renderSetup({}, "tmux");
    expect(screen.getByText("Step 3 of 5")).toBeTruthy();
  });

  it("counts the optional Network screen, which is the second of the five", async () => {
    await renderSetup({}, "network");
    expect(screen.getByText("Step 2 of 5")).toBeTruthy();
  });

  it("counts only its own four steps inside Subshell Server on Linux", async () => {
    // Spec 2026-09-17 deleted the native dot row the row used to continue
    // from: the assistant auto-fires, so there are no native screens to
    // count. This shell still cuts the Tmux step — the native screen owns
    // that act — but its row now says four, not seven.
    await underUA(SERVER_UA_LINUX, () => renderSetup({}, "agent"));
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
  });

  it("counts the same four on macOS — the permissions screen left the journey", async () => {
    // Used to read 7 of 8: macOS counted the assistant's "What macOS Will
    // Ask" step, which is request-only now (spec 2026-09-17 § 4). One of
    // this test's jobs is pinning that the two platforms no longer differ.
    await underUA(SERVER_UA_MACOS, () => renderSetup({}, "agent"));
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
  });
});

describe("setup wizard: the launch step", () => {
  /** The mocks the launch render needs: a real-shaped node list, a catalog
   *  with one usable agent, no presets (a fresh account has none), a home. */
  const LAUNCH_MOCKS: SetupMocks = {
    nodes: [LAUNCH_NODE, LAUNCH_AGENT],
    plugins: LAUNCH_PLUGINS,
    recent: { paths: [], home: "/home/ada" },
  };

  it("asks for the Agent (setup-agent), hides the Preset row, and teaches Terminal", async () => {
    await renderSetup(LAUNCH_MOCKS, "launch");
    const agentInput = screen.getByPlaceholderText("Choose an agent") as HTMLInputElement;
    expect(agentInput.id).toBe("setup-agent");
    // The terminal default composed: the picker reads Terminal.
    await waitFor(() => expect(agentInput.value).toBe("Terminal"));
    // First run hides the Preset row entirely — there is nothing to choose.
    expect(screen.queryByLabelText("Preset")).toBeNull();
    expect(screen.queryByRole("button", { name: "New preset" })).toBeNull();
    // And the Agent gets its one teaching hint (spec §5: the setup screen is
    // where the word is taught, once).
    expect(screen.getByText("The agent CLI this subshell runs. Terminal needs nothing installed.")).toBeDefined();
  });

  it("arrives filled in: Task 6's defaults make it submittable without input", async () => {
    await renderSetup(LAUNCH_MOCKS, "launch");
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    // Not just "eventually enabled" — the settle inside the walk means the
    // defaults have already composed; a regression in them fails HERE rather
    // than as a click that silently launches with blanks.
    expect(start.disabled).toBe(false);
    expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe("/home/ada");
  });

  it("launches a subshell and lands on it", async () => {
    const { history } = await renderSetup(LAUNCH_MOCKS, "launch");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    // The final ROUTER LOCATION, not just a navigate call: the redirect
    // effect on this page fires when the setup-status cache flips, and an
    // effect-bounce to "/" after the launch would pass a call spy while
    // leaving the user on the dashboard.
    await waitFor(() => expect(history.location.pathname).toBe("/subshells/sub-1"));
  });

  it("retires the setup-status cache on launch, so the shell does not bounce back", async () => {
    const { client } = await renderSetup(LAUNCH_MOCKS, "launch");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(client.getQueryData<{ needsSetup: boolean }>(["setup-status"])).toEqual({ needsSetup: false }),
    );
  });

  it("lets a user leave without launching, and still finishes setup", async () => {
    const { client, history } = await renderSetup(LAUNCH_MOCKS, "launch");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
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
      "launch",
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByText(/offline/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(history.location.pathname).toBe("/setup");
  });
});
