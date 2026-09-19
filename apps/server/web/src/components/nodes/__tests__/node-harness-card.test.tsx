import { afterEach, describe, expect, it } from "bun:test";
import type { NodeDetail, NodeHarness } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeHarnessCard } from "@/components/nodes/node-harness-card";

/**
 * The node page's harness card after the plugin inversion (spec 2026-09-10):
 * detection output, nothing more. One row per plugin the INSTANCE has
 * installed (the server's view already filters to that set), each carrying
 * this machine's binary answer, its version and the `checkedAt` stamp; a
 * manager's Re-check is the only control. No install, no remove, no
 * plugin-load notices — those are instance facts and live on
 * `/settings/plugins`.
 *
 * The fetch mock models the PRODUCER, not the card's wishes: rows are what
 * `GET /api/nodes/:id` sent (`effectiveHarnessStates` builds them from the
 * instance catalog, so `instanceHas` filters here exactly as the server
 * filters there). The `/api/setup/harnesses` endpoint answers with bait: the
 * old card listed anything that endpoint knew about that no row covered, as
 * Installable extras, so a card that resurrects that synthesis fails the
 * "absent, not shown as broken" case with "gone" reappearing as a row.
 */

interface CardOpts {
  /** Rows the node view carries (before the `instanceHas` server filter). */
  harnesses?: NodeHarness[];
  /** The viewer's server-derived access on the node view. */
  access?: NodeDetail["access"];
  inventoryStale?: boolean;
  kind?: NodeDetail["kind"];
  /** The plugins the instance has installed and enabled. */
  instanceHas?: string[];
  /** Status the POST to /recheck answers with (default 200 {ok:true}). */
  recheckStatus?: number;
  /** Whether this viewer manages the node — on `local`, the server's word for "admin". */
  canManage?: boolean;
  /**
   * Rows `GET /api/setup/harnesses` answers with. Defaults to the bait above;
   * the install tests supply real ones, which is where the install COMMAND
   * and the agent/terminal type come from (a node row carries neither).
   */
  infos?: unknown[];
  /**
   * NDJSON frames the install stream emits, in order. `null` inside the list
   * means "stop here and hold the stream open", which is how the in-flight
   * rendering is asserted without racing a close.
   */
  installFrames?: (string | null)[];
}

/** A `HarnessInfo` as `/api/setup/harnesses` sends it. */
function info(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "claude",
    name: "Claude",
    type: "agent-harness",
    binary: "claude",
    envOverride: "",
    description: "",
    installed: false,
    installedHere: true,
    install: { command: "curl -fsSL https://example.test/install.sh | bash", docsUrl: "" },
    ...over,
  };
}

const NODE_ID = "node1";

/** The install route's terminal frame for a run that worked. */
const DONE = { ok: true, exitCode: 0, output: "", harness: { id: "claude", installed: true } };

function view(over: Partial<NodeDetail>): NodeDetail {
  return {
    id: NODE_ID,
    name: "box",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "box",
    status: "online",
    lastSeenAt: null,
    agentVersion: "1.0.0",
    protocolVersion: 2,
    access: "owner",
    canManage: true,
    canLaunch: true,
    capabilities: [],
    allowedDirs: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    held: null,
    ...over,
  };
}

/** Render the card under a query client and a minimal router (its Link
 * targets `/settings/plugins`, and `RouterProvider` paints nothing until the
 * router has loaded once). Resolves once the node view has been fetched. */
async function mount(opts: CardOpts = {}): Promise<{ calls: { method: string; url: string }[]; restore: () => void }> {
  const calls: { method: string; url: string }[] = [];
  const original = globalThis.fetch;
  const data = view({
    kind: opts.kind ?? "agent",
    access: opts.access ?? "owner",
    canManage: opts.canManage ?? true,
    inventoryStale: opts.inventoryStale ?? false,
    harnesses: (opts.harnesses ?? []).filter((h) => !opts.instanceHas || opts.instanceHas.includes(h.harnessId)),
  });
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname });
    if (url.pathname === `/api/nodes/${NODE_ID}` && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(data)));
    }
    if (url.pathname === `/api/nodes/${NODE_ID}/recheck` && method === "POST") {
      const status = opts.recheckStatus ?? 200;
      if (status === 200) return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      return Promise.resolve(
        new Response(
          JSON.stringify({ errId: "e1", code: "NODE_OFFLINE", message: "node is offline", statusCode: status }),
          { status },
        ),
      );
    }
    // Bait for the deleted catalog synthesis (see the header comment).
    if (url.pathname === "/api/setup/harnesses") {
      return Promise.resolve(
        new Response(JSON.stringify(opts.infos ?? [{ id: "gone", name: "Gone", description: "", binary: "gone" }])),
      );
    }
    const agentInstall = /^\/api\/setup\/agents\/([^/]+)\/install$/.exec(url.pathname);
    if (agentInstall && method === "POST") {
      const frames = opts.installFrames ?? [`${JSON.stringify({ type: "done", ...DONE })}\n`];
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              for (const frame of frames) {
                // `null` holds the stream open: the reader has what came
                // before it and is still waiting, which is the state the
                // progress line describes.
                if (frame === null) return;
                controller.enqueue(encoder.encode(frame));
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
      >
        <NodeHarnessCard nodeId={NODE_ID} />
      </QueryClientProvider>
    ),
  });
  const pluginsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/plugins" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pluginsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(<RouterProvider router={router} />);
  // Wait out the node-view fetch so tests query loaded content directly.
  await waitFor(() => expect(calls.some((c) => c.url === `/api/nodes/${NODE_ID}` && c.method === "GET")).toBe(true));
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe("NodeHarnessCard", () => {
  afterEach(cleanup);

  it("the card manages nothing, even for the node's owner", async () => {
    // The route these controls POSTed to is gone (Task 9 deleted
    // set-node-plugin.route.ts), so even the owner gets no manage affordance
    // here — managing plugins moved to the instance page.
    const { restore } = await mount({ harnesses: [{ harnessId: "pi", name: "Pi", installed: true }] });
    try {
      expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
      expect(screen.queryByText(/add a plugin/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
    } finally {
      restore();
    }
  });

  it("rows come from detection, and say when they were checked", async () => {
    const iso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { restore } = await mount({
      harnesses: [{ harnessId: "pi", name: "Pi", installed: true, version: "1.2.3", checkedAt: iso }],
    });
    try {
      // The row leads with the instance store's display NAME, case-sensitively
      // pinned; the negative half is the same claim: the raw id is not what
      // the reader sees (spec 2026-09-10 follow-ups).
      expect(screen.getByText((content) => content === "Pi")).toBeDefined();
      expect(screen.queryByText((content) => content === "pi")).toBeNull();
      expect(screen.getByText(/1\.2\.3/)).toBeDefined();
      expect(screen.getByText(/checked/i)).toBeDefined();
      expect(screen.getByText("ready")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("Re-check issues exactly one detect", async () => {
    const { calls, restore } = await mount({ harnesses: [] });
    try {
      const btn = screen.getByRole("button", { name: /re-check/i });
      fireEvent.click(btn);
      await waitFor(() =>
        expect(calls.some((c) => c.method === "POST" && c.url === `/api/nodes/${NODE_ID}/recheck`)).toBe(true),
      );
      expect(calls.filter((c) => c.method === "POST" && c.url === `/api/nodes/${NODE_ID}/recheck`)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("an edit grantee is offered Re-check, because that is the server's gate", async () => {
    // The recheck route gates on `nodeCanConfigure` = owner|edit
    // (api/src/lib/node-access.ts), and the security posture documents it:
    // "edit (or owner) additionally configures the node (re-checks)".
    // Gating the button on `canManage` hid a permitted action — the button
    // mirrors the route, and the manage affordances stay gone for everyone.
    const { restore } = await mount({ harnesses: [{ harnessId: "pi", name: "Pi", installed: true }], access: "edit" });
    try {
      expect(screen.getByRole("button", { name: /re-check/i })).toBeDefined();
      expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
    } finally {
      restore();
    }
  });

  it("a view grantee is offered no Re-check, but sees the same rows", async () => {
    const { restore } = await mount({ harnesses: [{ harnessId: "pi", name: "Pi", installed: true }], access: "view" });
    try {
      expect(screen.queryByRole("button", { name: /re-check/i })).toBeNull();
      expect(screen.getByText((content) => content === "Pi")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("never offers Re-check on the local node (its probe is live on every read)", async () => {
    // The recheck route 400s `local`; the card offers only what the server
    // would honour.
    const { restore } = await mount({ harnesses: [], kind: "local" });
    try {
      expect(screen.queryByRole("button", { name: /re-check/i })).toBeNull();
    } finally {
      restore();
    }
  });

  it("a stale inventory says so rather than pretending", async () => {
    const { restore } = await mount({
      harnesses: [{ harnessId: "pi", name: "Pi", installed: true }],
      inventoryStale: true,
    });
    try {
      expect(screen.getByText(/last-known/i)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("a fresh inventory does not claim staleness", async () => {
    const { restore } = await mount({
      harnesses: [{ harnessId: "pi", name: "Pi", installed: true }],
      inventoryStale: false,
    });
    try {
      expect(screen.queryByText(/last-known/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("a harness the instance does not have is absent, not shown as broken", async () => {
    // The node's CACHED inventory can hold a plugin the instance no longer
    // has; the server's view never renders it as a row (rows are built from
    // the instance catalog — `effectiveHarnessStates`). The card's half of
    // this guarantee: it adds rows from NOTHING else — the bait catalog
    // entry above must not resurrect the old "Add a plugin" list.
    const { restore } = await mount({
      harnesses: [{ harnessId: "gone", name: "Gone", installed: true }],
      instanceHas: ["pi"],
    });
    try {
      // Both spellings: the card labels rows by NAME now, so the id probe
      // alone would go stale the day matching semantics shift. "gone" is
      // caught by RTL's case-insensitive whole-string match of "Gone"
      // either way; pinning both makes that explicit rather than implicit.
      expect(screen.queryByText("gone")).toBeNull();
      expect(screen.queryByText("Gone")).toBeNull();
      expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
    } finally {
      restore();
    }
  });

  it("renders no plugin-load state: broken and restartRequired are instance facts", async () => {
    // The wire may still carry these (they describe plugin loading in the
    // CONTROL-PLANE process, and the instance plugins page says so). On this
    // machine's card their absence is the visible proof the inversion
    // landed: a row never says "not usable", "could not load", or "restart".
    const { restore } = await mount({
      harnesses: [{ harnessId: "pi", name: "Pi", installed: true, broken: "boom at load", restartRequired: true }],
    });
    try {
      expect(screen.queryByText(/boom/i)).toBeNull();
      expect(screen.queryByText(/could not load/i)).toBeNull();
      expect(screen.queryByText(/not usable/i)).toBeNull();
      expect(screen.queryByText(/restart/i)).toBeNull();
      expect(screen.getByText("ready")).toBeDefined();
    } finally {
      restore();
    }
  });

  describe("Install on this server (spec 2026-09-15 § 5.3)", () => {
    /** `local` + a manager, with one agent CLI that is not here yet. */
    const localOpts = {
      kind: "local" as const,
      canManage: true,
      harnesses: [{ harnessId: "claude", name: "Claude", installed: false, reason: "not-on-path" as const }],
      infos: [info()],
    };

    it("offers the install to an admin on the control-plane host, and names what it runs", async () => {
      // The one entrance this route had was `/setup` step 2. Skip that screen
      // and there was no way back to it, ever — which is the defect this
      // second entrance closes.
      const { restore } = await mount(localOpts);
      try {
        expect(await screen.findByRole("button", { name: "Install on this server" })).toBeDefined();
        expect(screen.getByText(/curl -fsSL https:\/\/example\.test\/install\.sh \| bash/)).toBeDefined();
      } finally {
        restore();
      }
    });

    it("POSTs the install exactly once, to this harness's id", async () => {
      const { calls, restore } = await mount(localOpts);
      try {
        fireEvent.click(await screen.findByRole("button", { name: "Install on this server" }));
        await waitFor(() =>
          expect(calls.some((c) => c.method === "POST" && c.url === "/api/setup/agents/claude/install")).toBe(true),
        );
        expect(calls.filter((c) => c.method === "POST" && c.url === "/api/setup/agents/claude/install")).toHaveLength(
          1,
        );
      } finally {
        restore();
      }
    });

    it("shows the installer's own last line while it runs", async () => {
      const { restore } = await mount({
        ...localOpts,
        installFrames: [`${JSON.stringify({ type: "line", text: "downloading claude" })}\n`, null],
      });
      try {
        fireEvent.click(await screen.findByRole("button", { name: "Install on this server" }));
        expect(await screen.findByText("downloading claude")).toBeDefined();
      } finally {
        restore();
      }
    });

    it("reports a run that failed under the row that failed, with what it printed", async () => {
      const { restore } = await mount({
        ...localOpts,
        installFrames: [
          `${JSON.stringify({ type: "done", ok: false, exitCode: 2, output: "no such package", harness: { id: "claude", installed: false } })}\n`,
        ],
      });
      try {
        fireEvent.click(await screen.findByRole("button", { name: "Install on this server" }));
        expect(await screen.findByText(/exited with code 2/)).toBeDefined();
        expect(screen.getByText("no such package")).toBeDefined();
      } finally {
        restore();
      }
    });

    it("never offers it on an enrolled node, whoever is looking", async () => {
      // The route can only ever install on the control-plane host (spec
      // 2026-09-11 § 11 puts remote installs out of scope), so offering it
      // here would be a button that lies about which machine it changes.
      const { restore } = await mount({ ...localOpts, kind: "agent" });
      try {
        expect(await screen.findByText((c) => c === "Claude")).toBeDefined();
        expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
      } finally {
        restore();
      }
    });

    it("never offers it to a non-admin on the control-plane host", async () => {
      // `canManage` on `local` IS the admin answer, server-derived — the
      // same gate the route applies, rather than a second derivation of who
      // is an admin on this side.
      const { restore } = await mount({ ...localOpts, canManage: false, access: "edit" });
      try {
        expect(await screen.findByText((c) => c === "Claude")).toBeDefined();
        expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
      } finally {
        restore();
      }
    });

    it("offers nothing for a program that is already here", async () => {
      const { restore } = await mount({
        ...localOpts,
        harnesses: [{ harnessId: "claude", name: "Claude", installed: true }],
      });
      try {
        expect(await screen.findByText("ready")).toBeDefined();
        expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
      } finally {
        restore();
      }
    });

    it("offers nothing for a plugin that drives no program, or one with no install command", async () => {
      // `terminal` needs nothing installed, and the route 400s an id whose
      // install command is empty — a button for either would always fail.
      const { restore } = await mount({
        ...localOpts,
        harnesses: [
          { harnessId: "terminal", name: "Terminal", installed: false, reason: "no-binary" as const },
          { harnessId: "quiet", name: "Quiet", installed: false, reason: "not-on-path" as const },
        ],
        infos: [
          info({ id: "terminal", name: "Terminal", type: "terminal" }),
          info({ id: "quiet", name: "Quiet", install: { command: "  ", docsUrl: "" } }),
        ],
      });
      try {
        expect(await screen.findByText((c) => c === "Quiet")).toBeDefined();
        expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
      } finally {
        restore();
      }
    });
  });

  it("still explains a missing program and a bad override", async () => {
    // Kept verbatim: these are DETECTION reasons — facts about this machine.
    const { restore } = await mount({
      harnesses: [
        { harnessId: "claude", name: "Claude", installed: false, reason: "not-on-path" },
        { harnessId: "hermes", name: "Hermes", installed: false, reason: "override-invalid" },
        { harnessId: "pi", name: "Pi", installed: false, reason: "no-binary" },
      ],
    });
    try {
      // `claude` and `hermes` are both "program not found" (an override that
      // points at nothing is still a program that was not found); only
      // `pi`, which declares no program at all, reads ready.
      expect(screen.getAllByText("program not found")).toHaveLength(2);
      expect(screen.getByText(/environment variable overrides/i)).toBeDefined();
      expect(screen.getByText(/No separate program is needed here\./)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("a row nothing has probed says so, rather than claiming the program is missing", async () => {
    // The defect this closes: rows come from the INSTANCE catalog crossed
    // with the node's answer, so a plugin the node has never been asked about
    // arrives with neither `reason` nor `checkedAt` — and the card read that
    // as "program not found", asserting a negative about a machine that may
    // well have the CLI. Every real miss carries a reason
    // (`binary-lookup.ts`), so its absence is exactly "nobody looked".
    const { restore } = await mount({
      harnesses: [{ harnessId: "claude", name: "Claude", installed: false }],
    });
    try {
      expect(screen.getByText("not checked")).toBeDefined();
      expect(screen.queryByText("program not found")).toBeNull();
      expect(screen.getByText(/No detection has covered this plugin here yet/i)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("a probe that ran and did not complete is unknown, not a missing program", async () => {
    // `scanOne`'s catch records `installed: false` with a stamp and NO reason
    // on purpose: the probe itself failed, which is not the same as having
    // looked and not found it. The badge keeps that distinction.
    const { restore } = await mount({
      harnesses: [{ harnessId: "claude", name: "Claude", installed: false, checkedAt: new Date().toISOString() }],
    });
    try {
      expect(screen.getByText("check failed")).toBeDefined();
      expect(screen.queryByText("program not found")).toBeNull();
      expect(screen.getByText(/did not complete/i)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("surfaces a failed Re-check", async () => {
    const { restore } = await mount({ harnesses: [], recheckStatus: 409 });
    try {
      fireEvent.click(screen.getByRole("button", { name: /re-check/i }));
      expect(await screen.findByRole("alert")).toBeDefined();
      expect(screen.getByRole("alert").textContent).toContain("offline");
    } finally {
      restore();
    }
  });

  it("points at the instance plugins page for managing plugins", async () => {
    const { restore } = await mount({ harnesses: [] });
    try {
      const link = screen.getByRole("link", { name: /plugins/i });
      expect(link.getAttribute("href")).toContain("/settings/plugins");
    } finally {
      restore();
    }
  });
});
