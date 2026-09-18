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
import { useEffect, useState } from "react";
import { AddNodeDialog, installCommandFor } from "@/components/nodes/add-node-dialog";
import { NODES_QUERY_KEY } from "@/lib/query-keys";

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** The node rows `GET /api/nodes` serves; mutated by a test to stage an arrival. */
interface NodesHolder {
  /** `null` = the list route answers `{}`, i.e. a shape the dialog cannot read */
  rows: { id: string; name: string }[] | null;
}

/**
 * Stubs the setup-key create endpoint (sharing-dialog.test's fetch-mock
 * shape). `publicSettings` is the body served for GET /api/settings/public —
 * `{}` means "loaded but shape-missing", exercising the origin fallback.
 * `nodes.rows` is what the node list answers, so a test can stage which
 * machine arrived while the dialog waits.
 */
function mockFetch(publicSettings?: Record<string, unknown>, nodes: NodesHolder = { rows: null }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (method === "POST" && url.pathname === "/api/nodes/setup-keys") {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "k1", key: "nsk_secret", expiresAt: "2026-09-01T00:00:00Z" }), {
          status: 201,
        }),
      );
    }
    if (method === "GET" && url.pathname === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify(publicSettings ?? {}), { status: 200 }));
    }
    if (method === "GET" && url.pathname === "/api/nodes") {
      return Promise.resolve(new Response(JSON.stringify(nodes.rows ? { nodes: nodes.rows } : {}), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Raises the count prop the way the parent route's 3 s poll would. */
let raiseNodeCount: ((next: number) => void) | null = null;

function DialogHost({ start }: { start: number }) {
  const [count, setCount] = useState(start);
  useEffect(() => {
    raiseNodeCount = setCount;
    return () => {
      raiseNodeCount = null;
    };
  }, []);
  return <AddNodeDialog open onOpenChange={() => {}} nodeCount={count} />;
}

/**
 * The dialog links to the arrived node's page, so it needs a router in
 * context — a bare `Link` throws outside one. `/nodes/$id` is registered as a
 * dead-end route purely so the href resolves.
 */
async function renderDialog(nodeCount = 1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <DialogHost start={nodeCount} />,
  });
  const nodeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/nodes/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, nodeRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // Let the dialog's own reads land before a test acts. The node list in
  // particular is the baseline the arrival is diffed against, and a dialog
  // whose list has not loaded refuses to identify anything — which is correct
  // behaviour, and not what most of these tests are about.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  return {
    /** Re-reads `GET /api/nodes` (what the parent's poll does) and bumps the count prop. */
    async arrive(count: number) {
      await act(async () => {
        await client.refetchQueries({ queryKey: NODES_QUERY_KEY });
        raiseNodeCount?.(count);
      });
    },
  };
}

afterEach(cleanup);

describe("AddNodeDialog", () => {
  it("step 1 → create POSTs the label", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await waitFor(() => {
        const post = calls.find((c) => c.method === "POST" && c.url === "/api/nodes/setup-keys");
        expect(post).toBeDefined();
        expect(JSON.parse(post?.body ?? "{}")).toEqual({ label: "mac mini" });
      });
    } finally {
      restore();
    }
  });

  it("step 2 shows the key exactly once — inside the command, its only copy target", async () => {
    // The standalone key box and its subtitle are gone (operator's call,
    // 2026-09-18): the command carries the key, and a second box was a
    // second thing to copy for one paste. The load-bearing regression is
    // that removal did not drop the key from the command — hence the
    // count: the key-bearing element IS the command, and there is exactly
    // one of it.
    const { restore } = mockFetch();
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(
        await screen.findByText('curl -fsSL "http://localhost/install.sh?setup_key=nsk_secret" | bash'),
      ).toBeDefined();
      expect(screen.getAllByText(/nsk_secret/)).toHaveLength(1);
      expect(screen.getByText(/only time the full key is shown/i)).toBeDefined();
      expect(screen.getByText(/Waiting for enrollment/i)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("bakes the SERVER's appBaseUrl into the install command, not the browser origin", async () => {
    const { restore } = mockFetch({ appBaseUrl: "http://100.71.37.94:3080" });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(
        await screen.findByText('curl -fsSL "http://100.71.37.94:3080/install.sh?setup_key=nsk_secret" | bash'),
      ).toBeDefined();
      expect(screen.queryByText(/points at loopback/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("offers the dialable address from the dropdown and carries it as the bake choice", async () => {
    // The loopback case that used to earn an amber "APP_BASE_URL points at
    // loopback… replace the host" paragraph. The paragraph is gone and the
    // dropdown replaced it, because the advice it gave was only half true:
    // editing the curl host changed where the script DOWNLOADED from, while
    // the address the node dials forever is baked at render time. So the
    // dialog now names the choice in the URL (`server=`), and the route
    // bakes it — gated on the same trusted-origin registry the list came
    // from. Loopback rows are dropped when anything else is known, so the
    // default IS the reachable address.
    const { restore } = mockFetch({
      appBaseUrl: "http://localhost:3080",
      trustedOrigins: ["http://localhost:3080", "http://127.0.0.1:3080", "http://192.0.2.10:3080"],
    });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(
        await screen.findByText(
          'curl -fsSL "http://192.0.2.10:3080/install.sh?setup_key=nsk_secret&server=http://192.0.2.10:3080" | bash',
        ),
      ).toBeDefined();
      expect(screen.queryByText(/points at loopback/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("omits the bake choice when the selection is the base URL — today's command, byte for byte", async () => {
    // The stock case: the address the dropdown defaults to IS appBaseUrl, so
    // there is no deviation to carry and the route's default applies.
    const { restore } = mockFetch({
      appBaseUrl: "http://subshell.lan:3080",
      trustedOrigins: ["http://subshell.lan:3080"],
    });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(
        await screen.findByText('curl -fsSL "http://subshell.lan:3080/install.sh?setup_key=nsk_secret" | bash'),
      ).toBeDefined();
    } finally {
      restore();
    }
  });

  it("falls back to today's single-address command when nothing reachable is known — and warns of nothing", async () => {
    // Loopback-only (an old server with no LAN derivation): there is no
    // better address to offer, so the dropdown carries the one row it has
    // and the paragraph that used to shout about it is gone — the script's
    // own runtime loopback guard fires on the new machine, where the fact
    // is finally knowable.
    const { restore } = mockFetch({
      appBaseUrl: "http://localhost:3080",
      trustedOrigins: ["http://localhost:3080", "http://127.0.0.1:3080"],
    });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(
        await screen.findByText('curl -fsSL "http://localhost:3080/install.sh?setup_key=nsk_secret" | bash'),
      ).toBeDefined();
      expect(screen.queryByText(/points at loopback/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("the dropdown offers every reachable address and the default one drives both commands", async () => {
    // Which address a NON-default row would produce is `installCommandFor`'s
    // job, pinned below; this pins the wiring: the list on screen is the
    // allowlist, and what the commands name is the row the dropdown is on.
    // (No test in this suite commits a Base UI selection — the mobile
    // dialog's precedent stops at opening the list; the popup's pointer
    // events are the library's, not the dialog's.)
    const { restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      trustedOrigins: ["https://subshell.example", "https://plane.tail1234.ts.net"],
      nodeArtifactTargets: [],
      nodeArtifactsAutoFetch: false,
    });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);

      // async act: opening the Select arms Base UI's positioner, whose update
      // lands a microtask after a sync dispatch returns (mobile-install-dialog's precedent).
      await act(async () => {
        fireEvent.click(document.querySelector('[data-slot="select-trigger"]') as HTMLElement);
      });
      const rows = [...document.querySelectorAll('[data-slot="select-item"]')];
      expect(rows.map((r) => r.textContent)).toEqual([
        expect.stringContaining("https://subshell.example"),
        expect.stringContaining("https://plane.tail1234.ts.net"),
      ]);
      // The default (base URL) is on the commands, and needs no `server=`.
      expect(
        screen.getByText('curl -fsSL "https://subshell.example/install.sh?setup_key=nsk_secret" | bash'),
      ).toBeDefined();
      expect(screen.getByText('subshell enroll --server "https://subshell.example" --key "nsk_secret"')).toBeDefined();
    } finally {
      restore();
    }
  });

  describe("installCommandFor", () => {
    it("carries the chosen address only when it deviates from the base URL", () => {
      expect(installCommandFor("http://100.64.1.2:3080", "nsk_k", "http://localhost:3080")).toBe(
        'curl -fsSL "http://100.64.1.2:3080/install.sh?setup_key=nsk_k&server=http://100.64.1.2:3080" | bash',
      );
      // The stock case stays byte-identical to the command this predates.
      expect(installCommandFor("http://subshell.lan:3080", "nsk_k", "http://subshell.lan:3080")).toBe(
        'curl -fsSL "http://subshell.lan:3080/install.sh?setup_key=nsk_k" | bash',
      );
      // A path or trailing slash on the config value names the SAME origin,
      // so nothing is carried for a spelling difference.
      expect(installCommandFor("http://subshell.lan:3080", "nsk_k", "http://subshell.lan:3080/")).toBe(
        'curl -fsSL "http://subshell.lan:3080/install.sh?setup_key=nsk_k" | bash',
      );
    });

    it("suppresses curl's globber around an IPv6 origin, and only around one", () => {
      // `[fe80::1]` is a valid row the LAN probe can produce, and curl would
      // read its brackets as a range and die with `(3) bad range in URL`
      // before the server was ever asked. The fix travels only with the
      // addresses that need it: a non-bracket command stays byte-identical,
      // and with `-g` on the wire the param needs no percent-encoding (the
      // route test pins the raw bracketed spelling end to end).
      expect(installCommandFor("http://[fe80::1]:3080", "nsk_k", "http://localhost:3080")).toBe(
        'curl -fsSLg "http://[fe80::1]:3080/install.sh?setup_key=nsk_k&server=http://[fe80::1]:3080" | bash',
      );
      // Underscore hosts (`http://dev_server:3080`, another LAN regular)
      // are not glob characters and must NOT gain the flag — every stock
      // command stays exactly the string from before this feature.
      expect(installCommandFor("http://dev_server:3080", "nsk_k", "http://localhost:3080")).toBe(
        'curl -fsSL "http://dev_server:3080/install.sh?setup_key=nsk_k&server=http://dev_server:3080" | bash',
      );
    });

    it("carries nothing when the base URL is unknown or unparseable", () => {
      // Unloaded settings, and a server old enough to lack the field (which
      // would ignore the param anyway).
      expect(installCommandFor("http://192.168.1.14:3080", "nsk_k", undefined)).toBe(
        'curl -fsSL "http://192.168.1.14:3080/install.sh?setup_key=nsk_k" | bash',
      );
      expect(installCommandFor("http://192.168.1.14:3080", "nsk_k", "not a url")).toBe(
        'curl -fsSL "http://192.168.1.14:3080/install.sh?setup_key=nsk_k" | bash',
      );
    });
  });

  it("treats an unparseable appBaseUrl as not-loopback (no hint, no throw in render)", async () => {
    const { restore } = mockFetch({ appBaseUrl: "not a url" });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(await screen.findByText(/install\.sh\?setup_key=nsk_secret/)).toBeDefined();
      expect(screen.queryByText(/points at loopback/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("warns and offers the enroll fallback when the server has no binaries AND will not fetch", async () => {
    // The air-gapped case, which is the only one where "missing" means the
    // install cannot work: install.sh would 404 the download, so the dialog
    // must say so and hand over the manual enroll command.
    const { restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      nodeArtifactTargets: [],
      nodeArtifactsAutoFetch: false,
    });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(await screen.findByText(/has no agent binary for:/i)).toBeDefined();
      expect(screen.getByText('subshell enroll --server "https://subshell.example" --key "nsk_secret"')).toBeDefined();
      // The one-liner stays visible — it still works once artifacts exist.
      expect(screen.getByText(/install\.sh\?setup_key=nsk_secret/)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("names only the MISSING targets when artifacts are published for some", async () => {
    const { restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      nodeArtifactTargets: ["linux-x64", "linux-arm64"],
      nodeArtifactsAutoFetch: false,
    });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      const hint = await screen.findByText(/has no agent binary for:/i);
      expect(hint.textContent).toContain("darwin-arm64");
      expect(hint.textContent).not.toContain("linux-x64");
    } finally {
      restore();
    }
  });

  it("stays silent when every target is published", async () => {
    // Two shapes, TWO its: a loop here would keep iteration 1's dialog
    // mounted (cleanup is an afterEach hook), so iteration 2's findByText
    // resolves against the stale tree — a false green either way.
    const { restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      nodeArtifactTargets: ["linux-x64", "linux-arm64", "darwin-arm64"],
    });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      expect(screen.queryByText(/has no agent binary for:/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("does not warn about an empty artifacts dir when the server will fetch on demand", async () => {
    // The default install. Nothing is on disk and that is fine: the first
    // machine of a platform to run the one-liner triggers the download, so a
    // warning here would fire on every fresh instance and fix itself.
    const { restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      nodeArtifactTargets: [],
      nodeArtifactsAutoFetch: true,
    });
    try {
      await renderDialog();
      await screen.findByLabelText("Node name");
      expect(screen.queryByText(/has no agent binary for:/i)).toBeNull();
      // It says the first run is slower, once and quietly.
      expect(screen.getByText(/downloaded from the project's release the first time/i)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("stays silent when the server predates the field ({} — a cached PWA must not nag)", async () => {
    const { restore } = mockFetch({});
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      expect(screen.queryByText(/has no agent binary for:/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("shows the missing-artifacts warning already in step 1, before any key is minted", async () => {
    // The paragraph reads only /settings/public — making the operator burn a
    // single-use key to learn the one-liner 404s was the review finding.
    const { calls, restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      nodeArtifactTargets: [],
      nodeArtifactsAutoFetch: false,
    });
    try {
      await renderDialog();
      expect(await screen.findByText(/has no agent binary for:/i)).toBeDefined();
      // And no key was minted by merely opening the dialog.
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/nodes/setup-keys")).toBe(false);
    } finally {
      restore();
    }
  });

  it("says what the command does to the machine before it is run — and nothing about tmux", async () => {
    // The dialog is the one place in the product where a headless node
    // install is described; it used to describe nothing at all (spec
    // 2026-09-15 §5.4). Every clause here is a clause of install-script.ts.
    // The tmux paragraph is GONE (operator's call, 2026-09-18): `subshell
    // setup` preflights tmux and refuses before spending the key, and the
    // script's own output names the fix at the moment it matters — the
    // dialog's job is the command. The absence is pinned the way the mobile
    // dialog pins its removed address-explainer.
    const { restore } = mockFetch();
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      const what = await screen.findByText(/installs the agent to/i);
      expect(what.textContent).toContain("~/.local/bin");
      expect(what.textContent).toMatch(/background service/i);
      expect(what.textContent).toMatch(/at login/i);
      expect(screen.queryByText(/setup refuses without it/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("folds the first-run sentence INTO the what-it-does paragraph on step 2", async () => {
    // The two sentences that described one command now share one paragraph
    // (2026-09-18). Step 1 keeps its own standalone note; here the sentence
    // rides the paragraph it explains, on the SAME predicate — so a server
    // that fetches on demand with gaps in its published targets says both,
    // and the default `{}` shape (no verdict) says only the first.
    const { restore } = mockFetch({
      nodeArtifactTargets: ["linux-x64"],
      nodeArtifactsAutoFetch: true,
    });
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      const what = await screen.findByText(/installs the agent to/i);
      expect(what.textContent).toMatch(/downloaded from the project's release the first time/i);
    } finally {
      restore();
    }
  });

  it("names the node that arrived and links to its page", async () => {
    const nodes: NodesHolder = { rows: [{ id: "local", name: "Server" }] };
    const { restore } = mockFetch(undefined, nodes);
    try {
      const { arrive } = await renderDialog(1);
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      nodes.rows = [
        { id: "local", name: "Server" },
        { id: "n2", name: "mac mini" },
      ];
      await arrive(2);
      const line = await screen.findByText(/mac mini enrolled/i);
      expect(line).toBeDefined();
      const link = screen.getByRole("link", { name: /open its page/i });
      expect(link.getAttribute("href")).toBe("/nodes/n2");
    } finally {
      restore();
    }
  });

  it("falls back to the generic line when two machines arrived at once", async () => {
    // Guessing which of them is yours would put the operator on a stranger's
    // node page; the count is still true, so the old line still is.
    const nodes: NodesHolder = { rows: [{ id: "local", name: "Server" }] };
    const { restore } = mockFetch(undefined, nodes);
    try {
      const { arrive } = await renderDialog(1);
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      nodes.rows = [
        { id: "local", name: "Server" },
        { id: "n2", name: "mac mini" },
        { id: "n3", name: "someone else" },
      ];
      await arrive(3);
      expect(await screen.findByText(/Node enrolled\. Close this dialog/i)).toBeDefined();
      expect(screen.queryByRole("link", { name: /open its page/i })).toBeNull();
    } finally {
      restore();
    }
  });

  it("falls back to the generic line when the node list cannot identify the arrival", async () => {
    // The list answered a shape with no `nodes` (an older server, a failed
    // read): the count rose, so the enrollment is real — only the identity is
    // unknown, and a link is not worth guessing at.
    const { restore } = mockFetch();
    try {
      const { arrive } = await renderDialog(1);
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      await arrive(2);
      expect(await screen.findByText(/Node enrolled\. Close this dialog/i)).toBeDefined();
      expect(screen.queryByRole("link", { name: /open its page/i })).toBeNull();
    } finally {
      restore();
    }
  });
});
