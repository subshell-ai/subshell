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
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";
import { installCommandFor, setupCommandFor } from "@/components/nodes/node-key-setup";
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
  it("the mint is ONE press and sends no body", async () => {
    // There is no field any more: the node is named by the machine that becomes
    // it, so what this dialog's first step does is spend a key. A body would be
    // a name the server no longer has a column for.
    const { calls, restore } = mockFetch();
    try {
      await renderDialog();
      expect(screen.queryByLabelText("Node name")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      await waitFor(() => {
        const post = calls.find((c) => c.method === "POST" && c.url === "/api/nodes/setup-keys");
        expect(post).toBeDefined();
        expect(post?.body ?? "").toBe("");
      });
    } finally {
      restore();
    }
  });

  it("opens on the instructions, and holds no key until the press", async () => {
    // The two-step is gone (operator's call, 2026-09-18): opening the "Add node"
    // trigger lands on the screen the second step used to be, and the mint is one
    // press IN it. Before that press no key exists, and nothing pretends
    // otherwise: the app path's key row is a named placeholder, the terminal
    // one-liner shows only its PLACEHOLDER token with copy disabled, and no
    // `nsk_` string is on screen at all. The address row IS copyable from the
    // start — it needs no key.
    const { restore } = mockFetch({ appBaseUrl: "https://plane.example" });
    try {
      await renderDialog();
      expect(screen.getByRole("heading", { name: "Install Subshell Client" })).toBeDefined();
      expect(screen.queryByText("Add a node")).toBeNull();
      expect(screen.getByRole("button", { name: "Generate setup key" })).toBeDefined();
      // The command is on screen from the start (an empty tab reads as broken),
      // but its token slot is an unmistakable placeholder and copy is disabled —
      // the shape is the instruction; only the mint makes it runnable.
      expect(screen.queryByText(/nsk_/)).toBeNull();
      expect(screen.getByText(/setup_key=<generate setup key first>/)).toBeDefined();
      expect((screen.getByRole("button", { name: "Copy install command" }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Desktop App" }));
      expect(screen.getByText("Generate setup key first")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Copy setup key" })).toBeNull();
      expect(screen.getByRole("button", { name: "Copy server address" })).toBeDefined();

      // The press fills every placeholder and enables the copy.
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      await screen.findByRole("button", { name: "Copy setup key" });
      expect(screen.queryByText("Generate setup key first")).toBeNull();
      expect(screen.getAllByText(/nsk_secret/)).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
      expect(
        screen.getByText('curl -fsSL "https://plane.example/install.sh?setup_key=nsk_secret" | bash'),
      ).toBeDefined();
      expect((screen.getByRole("button", { name: "Copy install command" }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      restore();
    }
  });

  it("the terminal path shows the key once — inside the command — and says nothing else about it", async () => {
    // The command is still the terminal path's only carrier of the key (a second
    // box was a second thing to copy for one paste, operator's call 2026-09-18),
    // and the load-bearing regression is that removing the box never dropped the
    // key from the command — hence the count of exactly one. The prose around it
    // has been cut twice since: the "only time shown" warning went with the
    // 2026-09-17 revamp (the Setup keys card lists the key until it is spent),
    // and on 2026-09-18 the key-lifetime paragraph and the waiting line went too
    // — single-use/24 h is said once on that card, and an open dialog that polls
    // IS the waiting. Each absence pinned so none returns as a "restoration".
    const { restore } = mockFetch();
    try {
      await renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      expect(
        await screen.findByText('curl -fsSL "http://localhost/install.sh?setup_key=nsk_secret" | bash'),
      ).toBeDefined();
      expect(screen.getAllByText(/nsk_secret/)).toHaveLength(1);
      expect(screen.queryByText(/only time the full key is shown/i)).toBeNull();
      expect(screen.queryByText(/stays readable on the Setup keys list/i)).toBeNull();
      expect(screen.queryByText(/Waiting for enrollment/i)).toBeNull();
      // The reveal's own header carries no description either: the naming sentence
      // belongs to the mint screen, not to a screen about a machine not yet in hand.
      expect(screen.queryByText(/what to call itself/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("bakes the SERVER's appBaseUrl into the install command, not the browser origin", async () => {
    const { restore } = mockFetch({ appBaseUrl: "http://100.71.37.94:3080" });
    try {
      await renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
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
      expect(screen.getByText('subshell setup --server "https://subshell.example" --key "nsk_secret"')).toBeDefined();
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
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      expect(await screen.findByText(/install\.sh\?setup_key=nsk_secret/)).toBeDefined();
      expect(screen.queryByText(/points at loopback/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("warns and offers the setup fallback when the server has no binaries AND will not fetch", async () => {
    // The air-gapped case, which is the only one where "missing" means the
    // install cannot work: install.sh would 404 the download, so the dialog
    // must say so and hand over the verb to run by hand. `setup`, not `enroll`:
    // the primitive requires --name, which is the very question a person
    // standing at the machine should be ASKED rather than told to invent here.
    // The amber note also names the third door — the desktop app, which ships
    // its own agent and needs nothing from this server.
    const { restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      nodeArtifactTargets: [],
      nodeArtifactsAutoFetch: false,
    });
    try {
      await renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      expect(await screen.findByText(/has no agent binary for:/i)).toBeDefined();
      expect(screen.getByText('subshell setup --server "https://subshell.example" --key "nsk_secret"')).toBeDefined();
      // The one-liner stays visible — it still works once artifacts exist.
      expect(screen.getByText(/install\.sh\?setup_key=nsk_secret/)).toBeDefined();
      // And no first-run sentence anywhere — it was removed outright on
      // 2026-09-18, and here it never spoke anyway: `autoFetch` is false, so
      // the sentence describes a download that will never happen and the amber
      // refusal owns this screen.
      expect(screen.queryByText(/downloaded from the project/i)).toBeNull();
      // The branch's shape, stated (review, 2026-09-18): this screen shows
      // the plaintext key TWICE — once per command — because the two rows
      // are alternatives (you run one). The count-1 test above covers the
      // common single-command shape; together they pin the real invariant:
      // the key lives in commands and never outside one, one row or two.
      expect(screen.getAllByText(/nsk_secret/)).toHaveLength(2);
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
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      const hint = await screen.findByText(/has no agent binary for:/i);
      expect(hint.textContent).toContain("darwin-arm64");
      expect(hint.textContent).not.toContain("linux-x64");
    } finally {
      restore();
    }
  });

  it("stays silent when every target is published (the terminal reveal)", async () => {
    // Minting and reading the terminal panel, as named — the predicate is
    // shared, and the opposite shape (a server that fetches) is the other
    // test's. Two shapes, TWO its: a loop here would keep iteration 1's dialog
    // mounted (cleanup is an afterEach hook), so iteration 2's findByText
    // resolves against the stale tree — a false green either way.
    const { restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      nodeArtifactTargets: ["linux-x64", "linux-arm64", "darwin-arm64"],
    });
    try {
      await renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
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
      await screen.findByRole("button", { name: "Generate setup key" });
      expect(screen.queryByText(/has no agent binary for:/i)).toBeNull();
      // And the first-run sentence is gone entirely (operator's call, 2026-09-18):
      // no blurbs between the picker and the button.
      expect(screen.queryByText(/downloaded from the project/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("stays silent when the server predates the field ({} — a cached PWA must not nag)", async () => {
    const { restore } = mockFetch({});
    try {
      await renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      expect(screen.queryByText(/has no agent binary for:/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("shows the missing-artifacts warning before any key is minted, beside the command it refuses", async () => {
    // The verdict reads only /settings/public — making the operator burn a
    // single-use key to learn the one-liner 404s was the review finding. It
    // renders unconditionally in the terminal panel, so it reads before the
    // press and next to the very command it refuses.
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

  it("shows the command and says nothing else about the machine", async () => {
    // Two paragraphs used to sit above this command — one walking through what the
    // script does ("installs the agent to ~/.local/bin, asks what to call this
    // machine, enrolls it, and then asks about the background service"), one about
    // the first run per platform. Both are GONE (operator's call, 2026-09-18): the
    // command IS the instruction, and the script narrates itself on the machine it
    // runs on, at the moment each step happens. The absence is pinned the way the
    // mobile dialog pins its removed address-explainer, so the next reader treats it
    // as a decision rather than an oversight. What must survive is the command,
    // carrying the key.
    const { restore } = mockFetch();
    try {
      await renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      expect(screen.queryByText(/installs the agent to/i)).toBeNull();
      expect(screen.queryByText(/background service that starts it at login/i)).toBeNull();
      expect(screen.queryByText(/setup refuses without it/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("says nothing about the first run, in either state that used to say it", async () => {
    // The first-run sentence is GONE (operator's call, 2026-09-18), including in
    // the one combination that used to render it — `autoFetch` plus partially
    // published targets. Nothing sits between the address picker and the
    // Generate button. Pinned as an absence so it is not "restored".
    const { restore } = mockFetch({
      nodeArtifactTargets: ["linux-x64"],
      nodeArtifactsAutoFetch: true,
    });
    try {
      await renderDialog();
      expect(await screen.findByRole("button", { name: "Generate setup key" })).toBeDefined();
      expect(screen.queryByText(/downloaded from the project/i)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      expect(screen.queryByText(/downloaded from the project/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("names the node that arrived and links to its page", async () => {
    const nodes: NodesHolder = { rows: [{ id: "local", name: "Server" }] };
    const { restore } = mockFetch(undefined, nodes);
    try {
      const { arrive } = await renderDialog(1);
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
      await screen.findByText(/install\.sh\?setup_key=nsk_secret/);
      await arrive(2);
      expect(await screen.findByText(/Node enrolled\. Close this dialog/i)).toBeDefined();
      expect(screen.queryByRole("link", { name: /open its page/i })).toBeNull();
    } finally {
      restore();
    }
  });

  // ── the two paths ───────────────────────────────────────────────────────

  describe("Terminal | Desktop App", () => {
    it("defaults to the terminal and switches to the app's two values", async () => {
      // The app cannot be handed a command line: its Enroll step takes a server
      // URL and a setup key as fields. So the second path exists, and what it
      // shows is those two things — each with its own copy button that says
      // which one it copies.
      const { restore } = mockFetch({ appBaseUrl: "https://plane.example" });
      try {
        await renderDialog();
        fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
        const terminal = await screen.findByRole("button", { name: "Terminal" });
        expect(screen.getByRole("button", { name: "Desktop App" })).toBeDefined();
        expect(terminal.getAttribute("aria-pressed")).toBe("true");
        expect(
          screen.getByText('curl -fsSL "https://plane.example/install.sh?setup_key=nsk_secret" | bash'),
        ).toBeDefined();

        fireEvent.click(screen.getByRole("button", { name: "Desktop App" }));
        expect(screen.queryByText(/install\.sh\?setup_key=/)).toBeNull();
        // The sentence that used to walk someone through opening the app is GONE
        // (operator's call, 2026-09-18): the two labelled rows ARE the instruction.
        // Asserted as an absence so the panel does not quietly regrow it.
        expect(screen.queryByText(/Window → This machine/i)).toBeNull();
        // The address shows TWICE on screen by design: the picker states the choice
        // and the row below is what gets pasted into the app. A raw text count is
        // the wrong instrument now that the reveal mounts at open — the CLOSED
        // dropdown's items are in the DOM too — Base UI force-mounts them once the
        // trigger has focus, which is where the dialog's initial focus lands (the
        // old count of 2 rode the two-step never focusing the trigger — timing, not
        // truth). The paste target is the CODE row, and
        // there is exactly one. The key shows ONCE.
        expect(screen.getAllByText("https://plane.example").filter((el) => el.tagName === "CODE")).toHaveLength(1);
        expect(screen.getAllByText(/nsk_secret/)).toHaveLength(1);
        expect(screen.getByRole("button", { name: "Copy setup key" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Copy server address" })).toBeDefined();

        // And back: the switch hides a panel, it does not destroy the command.
        fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
        expect(
          screen.getByText('curl -fsSL "https://plane.example/install.sh?setup_key=nsk_secret" | bash'),
        ).toBeDefined();
        expect(screen.queryByRole("button", { name: "Copy setup key" })).toBeNull();
      } finally {
        restore();
      }
    });

    it("leads the app path with the download, on the app path only", async () => {
      // Nobody is assumed to already have Subshell Client (operator's call,
      // 2026-09-18): the server ships no desktop bundles, so getting the app is
      // step ONE and precedes the two Enroll values. The terminal path needs no
      // such line — curl exists everywhere. The GitHub link is `?q=`-filtered,
      // never `/releases/latest`: four components share this repo and "latest"
      // is whichever was tagged last, which can be a server release.
      const { restore } = mockFetch({ appBaseUrl: "https://plane.example" });
      try {
        await renderDialog();
        fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
        await screen.findByRole("button", { name: "Terminal" });
        expect(screen.queryByRole("link", { name: /download the subshell client app/i })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Desktop App" }));
        const link = screen.getByRole("link", { name: /download the subshell client app/i });
        expect(link.getAttribute("href")).toBe("https://github.com/subshell-ai/subshell/releases?q=desktop-client");
        expect(link.getAttribute("target")).toBe("_blank");
        // FIRST step: before the two values, not a footnote after them.
        const serverRow = screen.getByText("Server address");
        expect(link.compareDocumentPosition(serverRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      } finally {
        restore();
      }
    });

    it("keeps the address picker above the switch, because both paths dial it", async () => {
      const { restore } = mockFetch({
        appBaseUrl: "https://plane.example",
        trustedOrigins: ["https://plane.example", "http://192.0.2.10:3080"],
      });
      try {
        await renderDialog();
        fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
        const label = await screen.findByText("Select Subshell server address");
        // Above the switch, not inside either panel — the pick decides the baked
        // SERVER on the terminal path AND the value the app's Connect step gets.
        const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement;
        const switchButton = screen.getByRole("button", { name: "Desktop App" }) as HTMLElement;
        expect(label.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(trigger.compareDocumentPosition(switchButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // The pick is the same value the app path's paste row carries — one CODE row
        // (the closed dropdown holds further copies in the DOM; see the count comment
        // in the test above).
        fireEvent.click(screen.getByRole("button", { name: "Desktop App" }));
        expect(screen.getAllByText("https://plane.example").filter((el) => el.tagName === "CODE")).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("says nothing about unpublished agent binaries on the app path — the app ships its own", async () => {
      // The amber refusal is a statement about the DOWNLOAD, which is a
      // terminal-path fact. On the air-gapped branch it must not follow the
      // operator across the switch.
      const { restore } = mockFetch({
        appBaseUrl: "https://plane.example",
        nodeArtifactTargets: [],
        nodeArtifactsAutoFetch: false,
      });
      try {
        await renderDialog();
        fireEvent.click(screen.getByRole("button", { name: "Generate setup key" }));
        expect(await screen.findByText(/has no agent binary for:/i)).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: "Desktop App" }));
        expect(screen.queryByText(/has no agent binary for:/i)).toBeNull();
        expect(screen.getByText(/nsk_secret/)).toBeDefined();
      } finally {
        restore();
      }
    });

    it("names the desktop path in the amber refusal, since it needs no published binary", async () => {
      const { restore } = mockFetch({
        appBaseUrl: "https://plane.example",
        nodeArtifactTargets: [],
        nodeArtifactsAutoFetch: false,
      });
      try {
        await renderDialog();
        // Said BEFORE the key is minted: this is the screen where the operator
        // still has a choice to make, and the app is one of the choices.
        expect(await screen.findByText(/has no agent binary for:/i)).toBeDefined();
        expect(screen.getByText(/Subshell Client app/i)).toBeDefined();
      } finally {
        restore();
      }
    });
  });

  describe("setupCommandFor", () => {
    it("is the verb run by hand, with the address quoted and the name left to the machine", () => {
      // No --name: `setup` asks. `enroll` would demand one, which is a fact the
      // browser cannot know and the person at the machine can.
      expect(setupCommandFor("http://100.64.1.2:3080", "nsk_k")).toBe(
        'subshell setup --server "http://100.64.1.2:3080" --key "nsk_k"',
      );
    });
  });
});
