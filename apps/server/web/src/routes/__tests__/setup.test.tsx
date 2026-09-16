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
  /** What GET /api/network answers (the Network step); default is no networks */
  networks?: unknown[];
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
   * What GET /api/admin/status reports for `runtime.tmuxPath` — the tmux row's
   * whole detection. `undefined` here means "found", since that is the state
   * of a host the wizard has nothing to say about.
   */
  tmuxPath?: string | null;
  /** What GET /api/admin/status reports for `runtime.os`, which decides the command shown. */
  os?: string;
  /** What POST /api/setup/tmux/install answers */
  tmuxInstall?: { status: number; body: unknown };
}

/**
 * Bodies the stubbed better-auth sign-up endpoint received, in order.
 *
 * Module-level rather than per-render because `routeFetch` is the only place
 * that endpoint is answered; cleared in `afterEach` with the router itself.
 */
const signUpBodies: unknown[] = [];

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
    if (path === "/api/setup/status") return Promise.resolve(new Response(JSON.stringify({ needsSetup: true })));
    if (path === "/api/setup/harnesses") {
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
      // Only the two fields the wizard reads. The real body is much wider and
      // has its own suite; mirroring it here would be a second fixture to keep
      // in step with a schema this page does not care about.
      const tmuxPath = installedTmux ?? (opts.tmuxPath === undefined ? "/usr/bin/tmux" : opts.tmuxPath);
      return Promise.resolve(new Response(JSON.stringify({ runtime: { tmuxPath, os: opts.os ?? "darwin" } })));
    }
    if (path === "/api/setup/tmux/install" && method === "POST") {
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

/**
 * Renders the wizard and walks it to `upto`: 0 = account form,
 * 1 = network step (through real registration against the stubbed auth),
 * 2 = agent step, 3 = launch step. The walk IS the test substrate — the point
 * of this page is the path through it.
 */
async function renderSetup(opts: SetupMocks, upto: 0 | 1 | 2 | 3) {
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
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
    // Wait on real step-1 CONTENT (the network screen's own heading), not the
    // button label: "Creating account…" makes "Create Account" vanish while
    // the sign-up promise is still in flight.
    await waitFor(() => expect(screen.getByText("Connect a Network")).toBeTruthy());
  }
  if (upto >= 2) {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("Claude Code")).toBeTruthy());
  }
  if (upto >= 3) {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
  }
  return { client, history };
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
  signUpBodies.length = 0;
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
    await renderSetup({}, 0);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Ada  " } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " ada@example.com " } });
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
    await renderSetup({}, 2);
    expect(screen.getByText(/A plain terminal is always available/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("keeps the node escape hatch for a machine with nothing usable", async () => {
    await renderSetup({ harnesses: [CLAUDE_ABSENT] }, 2);
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
      2,
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
    await renderSetup({ harnesses: [CLAUDE_ABSENT], installPending: true }, 2);
    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(cont.hasAttribute("disabled")).toBe(true));
    // The progress lives on the ROW, not beside the button: the bar carries
    // no status text at all (operator's call, 2026-09-14).
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain("Installing…");
  });

  it("installs an agent and flips the row to Detected", async () => {
    await renderSetup({ harnesses: [CLAUDE_ABSENT] }, 2);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await settle();
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    await waitFor(() => expect(row.textContent).toContain("Detected · v1.0.0"));
  });
});

/**
 * The tmux row (spec 2026-09-15 § 5.1).
 *
 * The defect it closes is that the browser wizard had no tmux step at all —
 * the screen existed only in the native Subshell Server assistant, so a
 * headless install discovered that every launch fails, or never found out.
 * tmux is what every local pane runs inside.
 */
describe("setup wizard: the tmux row", () => {
  it("pins tmux above the agents and reports a host that has it", async () => {
    await renderSetup({}, 2);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.getAttribute("aria-label")).toBe("tmux");
    expect(rows[0]?.textContent).toContain("Detected");
    // A settled fact says nothing more: no command to run, nothing to press.
    // Scoped to the row — Claude Code is absent in the default fixture and
    // carries an Install button of its own.
    expect(within(rows[0] as HTMLElement).queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("says what a missing tmux costs and never blocks Continue", async () => {
    await renderSetup({ tmuxPath: null }, 2);
    const row = screen.getByRole("listitem", { name: "tmux" });
    expect(row.textContent).toContain("Subshells cannot launch on this machine");
    // The launch step refuses honestly on its own, and a wizard that traps
    // someone behind a package manager is worse than one that told them.
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
  });

  it("installs tmux on macOS and flips the row to Detected", async () => {
    await renderSetup({ tmuxPath: null, os: "darwin" }, 2);
    fireEvent.click(within(screen.getByRole("listitem", { name: "tmux" })).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.getByRole("listitem", { name: "tmux" }).textContent).toContain("Detected"));
  });

  it("shows the Linux command to copy and offers no button for it", async () => {
    // The server has no terminal to answer sudo's password prompt, so the
    // route 409s a privileged installer. A button here would always fail.
    await renderSetup({ tmuxPath: null, os: "linux" }, 2);
    const row = screen.getByRole("listitem", { name: "tmux" });
    expect(row.textContent).toContain("sudo apt-get install -y tmux");
    expect(within(row).queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("reports a refused install without pretending tmux arrived", async () => {
    await renderSetup(
      {
        tmuxPath: null,
        os: "darwin",
        tmuxInstall: { status: 409, body: { message: "No supported package manager was found on this host." } },
      },
      2,
    );
    fireEvent.click(within(screen.getByRole("listitem", { name: "tmux" })).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(screen.getByRole("listitem", { name: "tmux" }).textContent).toContain(
        "No supported package manager was found on this host.",
      ),
    );
  });
});

/**
 * One `GET /api/network` row. Only the fields the step's own layout reads —
 * the card's state matrix has its own suite next door
 * (`components/__tests__/network-plugin-card.test.tsx`).
 */
function network(over: { id: string; name: string; state?: string; installed?: boolean }) {
  const state = over.state ?? "not-installed";
  return {
    id: over.id,
    name: over.name,
    description: `${over.name} network`,
    exposure: "private",
    labels: {},
    platforms: ["darwin", "linux"],
    supported: true,
    enabled: true,
    interactiveLogin: true,
    privileged: [{ label: `Install ${over.name}`, command: `brew install ${over.id}` }],
    settingsFields: [],
    settings: {},
    status: { state, addresses: [], hints: [] },
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
  it("is optional, and skipping lands on the agent step", async () => {
    await renderSetup({}, 1);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(screen.getByText("Add an Agent")).toBeTruthy());
  });

  it("leads with a network this machine already has and files the rest under Other networks", async () => {
    await renderSetup(
      {
        networks: [
          network({ id: "later", name: "Later" }),
          network({ id: "tailscale", name: "Tailscale", state: "joined" }),
        ],
      },
      1,
    );
    const rows = await screen.findAllByRole("listitem");
    // Ordering is the whole layout decision: a network the machine has is a
    // question a person can answer right now.
    expect(rows[0]?.getAttribute("aria-label")).toBe("Tailscale");
    // The one needing an install is present but folded away, with its own
    // privileged step to copy.
    const later = screen.getByRole("listitem", { name: "Later" });
    expect(later.textContent).toContain("brew install later");
    expect(screen.getByText("Other networks")).toBeTruthy();
  });

  it("says so plainly when this build ships no networks at all", async () => {
    await renderSetup({}, 1);
    expect(await screen.findByText(/ships no network plugins/)).toBeTruthy();
  });
});

describe("setup wizard: the dot row continues the native assistant", () => {
  afterEach(() => {
    resetDesktopShellForTests();
  });

  it("reads Step 3 of 4 under a plain browser UA", async () => {
    // Four screens now: Account, Network, Agent, Launch. The walk stops on
    // the third.
    await renderSetup({}, 2);
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
  });

  it("counts the optional Network screen, which is the second of the four", async () => {
    await renderSetup({}, 1);
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
  });

  /** Renders step `n` under `userAgent`, restoring the real one afterwards. */
  async function underUA(userAgent: string, n: 0 | 1 | 2 | 3) {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const prev = Object.getOwnPropertyDescriptor(nav, "userAgent");
    resetDesktopShellForTests();
    Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true });
    try {
      await renderSetup({}, n);
    } finally {
      if (prev) Object.defineProperty(nav, "userAgent", prev);
      else delete nav.userAgent;
      resetDesktopShellForTests();
    }
  }

  it("reads Step 6 of 7 on Linux, continuing the assistant's three native screens", async () => {
    await underUA("Mozilla/5.0 SubshellDesktop/1.0.0 (linux; p=1)", 2);
    expect(screen.getByText("Step 6 of 7")).toBeTruthy();
  });

  it("reads Step 7 of 8 on macOS — the assistant shows a fourth screen there", async () => {
    // "What macOS Will Ask" sits between Install tmux and Set Up, and exists
    // only on the platform that asks (spec 2026-09-14 §3, §6).
    await underUA("Mozilla/5.0 SubshellDesktop/1.0.0 (macos; p=1)", 2);
    expect(screen.getByText("Step 7 of 8")).toBeTruthy();
  });
});

describe("setup wizard: the launch step", () => {
  /** The mocks a step-2 render needs: a real-shaped node list, a catalog with
   *  one usable agent, no presets (a fresh account has none), a home. */
  const LAUNCH_MOCKS: SetupMocks = {
    nodes: [LAUNCH_NODE, LAUNCH_AGENT],
    plugins: LAUNCH_PLUGINS,
    recent: { paths: [], home: "/home/ada" },
  };

  it("asks for the Agent (setup-agent), hides the Preset row, and teaches Terminal", async () => {
    await renderSetup(LAUNCH_MOCKS, 3);
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
    await renderSetup(LAUNCH_MOCKS, 3);
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    // Not just "eventually enabled" — the settle inside the walk means the
    // defaults have already composed; a regression in them fails HERE rather
    // than as a click that silently launches with blanks.
    expect(start.disabled).toBe(false);
    expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe("/home/ada");
  });

  it("launches a subshell and lands on it", async () => {
    const { history } = await renderSetup(LAUNCH_MOCKS, 3);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    // The final ROUTER LOCATION, not just a navigate call: the redirect
    // effect on this page fires when the setup-status cache flips, and an
    // effect-bounce to "/" after the launch would pass a call spy while
    // leaving the user on the dashboard.
    await waitFor(() => expect(history.location.pathname).toBe("/subshells/sub-1"));
  });

  it("retires the setup-status cache on launch, so the shell does not bounce back", async () => {
    const { client } = await renderSetup(LAUNCH_MOCKS, 3);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(client.getQueryData<{ needsSetup: boolean }>(["setup-status"])).toEqual({ needsSetup: false }),
    );
  });

  it("lets a user leave without launching, and still finishes setup", async () => {
    const { client, history } = await renderSetup(LAUNCH_MOCKS, 3);
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
      3,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByText(/offline/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(history.location.pathname).toBe("/setup");
  });
});
