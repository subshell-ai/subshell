import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { NetworkPluginCard } from "@/components/networking/network-plugin-card";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { setFetchRouter } from "@/test-setup";
import type { NetworkRow, NetworkState } from "@/types/network";

/**
 * The card's state matrix (one test per state), plus the three rules that are
 * not about any single state: a secret is never echoed, a refusal is an
 * answer rather than an error, and a `public-with-gate` network says what
 * publishing it means before anything else on the row.
 *
 * Each state test asserts a control that MUST be there and one that must NOT.
 * The second half is the half that catches a regression: a state machine that
 * leaks Publish into `needs-login` still renders everything the first half
 * looks for.
 */

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

function row(over: Partial<NetworkRow> & { state?: NetworkState } = {}): NetworkRow {
  const { state, ...rest } = over;
  return {
    id: "tailscale",
    name: "Tailscale",
    description: "A private network for your own devices.",
    exposure: "private",
    labels: { credential: "Auth key", publish: "Publish with Tailscale Serve" },
    platforms: ["darwin", "linux"],
    supported: true,
    enabled: true,
    interactiveLogin: true,
    privileged: [],
    settingsFields: [],
    settings: {},
    published: state === "published",
    status: {
      state: state ?? "needs-login",
      addresses: [],
      hints: [],
    },
    ...rest,
  };
}

/** The two addresses a joined network reports: one secure, one not. */
const ADDRESSES = [
  { url: "https://box.tail1234.ts.net", scheme: "https" as const, label: "MagicDNS name", secureContext: true },
  { url: "http://100.64.0.1:3080", scheme: "http" as const, label: "Tailscale IP", secureContext: false },
];

/** Renders the card inside a throwaway router + query client (it uses both). */
async function renderCard(value: NetworkRow, compact = false): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <QueryClientProvider client={client}>
        {/* The same provider `__root` mounts: Disconnect asks through the
            app's one confirmation mechanism rather than a dialog of its own. */}
        <ConfirmProvider>
          {compact ? (
            // The list item and the name are `NetworkRow`'s, not the card's:
            // in `compact` the card renders its body alone, so the wizard's
            // row can own both. This stands in for that row.
            <ul>
              <li aria-label={value.name}>
                <NetworkPluginCard row={value} compact />
              </li>
            </ul>
          ) : (
            <NetworkPluginCard row={value} />
          )}
        </ConfirmProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** An NDJSON stream: some progress, then one terminal frame. */
function ndjson(done: unknown, lines: string[] = []): Response {
  const body = [...lines.map((text) => JSON.stringify({ type: "line", text })), JSON.stringify(done)].join("\n");
  return new Response(body, { status: 200 });
}

/** Routes every request this card can make; records what went out. */
function mockFetch(handler: (url: URL, init?: RequestInit) => Response | undefined) {
  const calls: { method: string; pathname: string; body?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ method: init?.method ?? "GET", pathname: url.pathname, body: init?.body as string | undefined });
    // `GET /api/admin/server` answers for real, because a `{}` for it is not
    // a harmless stub: `NetworkRestartNotice` mounts that query whenever a
    // publish reports `restartRequired`, guards `!view` and then reads
    // `view.restart.available` — which `{}` satisfies as truthy and then
    // throws on. The throw is caught by the router's CatchBoundary, so the
    // test that triggered it still passed while the boundary rebuilt the tree
    // from scratch underneath whatever ran next. That is what made a
    // neighbouring test time out in CI and pass everywhere else.
    if (url.pathname === "/api/admin/server") {
      return Promise.resolve(handler(url, init) ?? Response.json(deploymentView()));
    }
    return Promise.resolve(handler(url, init) ?? new Response(JSON.stringify({})));
  }) as typeof fetch;
  // ALSO route the preload's delegator, not just the global. Replacing
  // `globalThis.fetch` only catches call-time users; anything that bound fetch
  // at import (better-auth's client does) captured the delegator instead and
  // goes straight to the real network. This suite was making 80 refused
  // connections per CI run, to `127.0.0.1:80` for relative URLs and to
  // `127.0.0.1:3080` for the configured base URL — and on a developer's own
  // machine 3080 usually has a real server answering, so the suite was not
  // merely leaky but leaky in a way that behaves differently per machine.
  setFetchRouter(globalThis.fetch as typeof fetch);
  restore.push(() => {
    globalThis.fetch = original;
    setFetchRouter(null);
  });
  return calls;
}

describe("NetworkPluginCard: the state matrix", () => {
  it("a platform this plugin cannot drive offers nothing at all", async () => {
    await renderCard(row({ supported: false, platforms: ["linux"], status: undefined }));
    expect(screen.getByText(/Not available on this server's platform/)).toBeTruthy();
    expect(screen.getByText(/runs on Linux/)).toBeTruthy();
    // No act is possible here, so none is offered — not even Re-check.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a disabled plugin points at the page that re-enables it, and acts on nothing", async () => {
    await renderCard(row({ enabled: false, status: undefined }));
    expect(screen.getByRole("link", { name: /Settings → Plugins/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("not-installed numbers the privileged steps and never offers to run one", async () => {
    await renderCard(
      row({
        state: "not-installed",
        privileged: [
          { label: "Install the daemon", command: "brew install tailscale" },
          { label: "Start it at boot", command: "sudo tailscaled install-system-daemon", docsUrl: "https://ts.net" },
        ],
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    expect(card.textContent).toContain("1.Install the daemon");
    expect(card.textContent).toContain("2.Start it at boot");
    // Copy-only: the server has no terminal to answer a password prompt, so a
    // button here would be a control that always fails.
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBe(2);
  });

  it("not-installed runs the hints on from the privileged steps, as one sequence", async () => {
    // The shape the first shipped plugin actually has: every Tailscale
    // install path needs root, a manifest may not carry a `sudo` command, and
    // the steps therefore arrive as privileged HINTS. They are the whole
    // install experience, so they have to read as steps rather than as
    // footnotes under the two numbered ones.
    await renderCard(
      row({
        state: "not-installed",
        privileged: [{ label: "Install the daemon", command: "brew install tailscale" }],
        status: {
          state: "not-installed",
          addresses: [],
          hints: [
            {
              text: "Then register it as a system daemon.",
              command: "sudo tailscaled install-system-daemon",
              privileged: true,
            },
            { text: "Then come back and re-check.", privileged: true },
          ],
        },
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    expect(card.textContent).toContain("1.Install the daemon");
    expect(card.textContent).toContain("2.Then register it as a system daemon.");
    // A hint with no command is NOT step 3. It is the sentence explaining what
    // to do once the two steps above are done, and numbering it would tell the
    // reader to perform a sentence.
    expect(card.textContent).toContain("Then come back and re-check.");
    expect(card.textContent).not.toContain("3.");
    // Still copy-only, however they arrived.
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("leads with the state's own sentence, ABOVE the numbered steps", async () => {
    // What a person meets first has to be what is wrong. The sentence is the
    // one thing the live status knows and the manifest cannot, and it used to
    // render UNDER the steps it explains — so a card opened on a machine with
    // nothing installed began with "1. Install the Tailscale daemon" and
    // buried "Tailscale is not installed on this machine" in the middle, in
    // the same muted grey as a step label.
    await renderCard(
      row({
        state: "not-installed",
        privileged: [
          { label: "Install the daemon", command: "brew install tailscale" },
          { label: "Allow this server to control Tailscale", command: "sudo tailscale set --operator=$USER" },
        ],
        status: {
          state: "not-installed",
          addresses: [],
          hints: [{ text: "Tailscale is not installed on this machine.", docsUrl: "https://ts.net/install" }],
        },
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    const text = card.textContent ?? "";
    expect(text.indexOf("Tailscale is not installed on this machine.")).toBeLessThan(
      text.indexOf("1.Install the daemon"),
    );
    // A lead sentence is not step 1 of anything, so the steps still start at 1.
    expect(text).toContain("1.Install the daemon");
    expect(text).toContain("2.Allow this server to control Tailscale");
    // Each manifest command is rendered exactly ONCE.
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBe(2);
  });

  it("keeps a sentence that FOLLOWS the plugin's own commands where the plugin put it", async () => {
    // The mirror of the test above, and the reason the split is "hints before
    // the FIRST COMMAND" rather than "every hint without a command". Once a
    // plugin's hints carry a sequence of their own, a closing sentence
    // explains what to do AFTER it, and hoisting that to the top would state
    // the last instruction first.
    await renderCard(
      row({
        state: "not-installed",
        privileged: [{ label: "Install the daemon", command: "brew install tailscale" }],
        status: {
          state: "not-installed",
          addresses: [],
          hints: [
            { text: "Then register it as a system daemon.", command: "sudo tailscaled install-system-daemon" },
            { text: "Then come back and re-check." },
          ],
        },
      }),
    );
    const text = screen.getByRole("group", { name: "Tailscale" }).textContent ?? "";
    // Nothing is hoisted: the list opens with a command, so it has no lead.
    expect(text.indexOf("1.Install the daemon")).toBeLessThan(text.indexOf("2.Then register it as a system daemon."));
    expect(text.indexOf("2.Then register it as a system daemon.")).toBeLessThan(
      text.indexOf("Then come back and re-check."),
    );
  });

  it("renders a docs link only for a URL a browser may navigate to", async () => {
    // The server strips these before they get here — twice — so this asserts
    // the sink's own refusal, which is the one an upstream omission cannot
    // reach past. It deliberately does not rely on React neutralizing a
    // `javascript:` href: that is an internal of a rendering library.
    await renderCard(
      row({
        state: "not-installed",
        privileged: [
          { label: "Install the daemon", command: "brew install tailscale", docsUrl: "javascript:alert(1)" },
        ],
        install: { command: "brew install tailscale", docsUrl: "javascript:alert(2)" },
        status: {
          state: "not-installed",
          addresses: [],
          hints: [
            { text: "Finish signing in.", docsUrl: "javascript:alert(3)" },
            { text: "Read the docs.", docsUrl: "https://example.invalid/docs" },
          ],
        },
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    const links = [...card.querySelectorAll("a")];
    // Exactly one survives, and it is the http(s) one. The sentences beside
    // the dropped links are still rendered — what is withheld is the anchor.
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.invalid/docs"]);
    expect(card.textContent).toContain("Finish signing in.");
    expect(card.textContent).toContain("Install the daemon");
    expect(card.innerHTML).not.toContain("javascript:");
  });

  it("a single thing to do is not numbered", async () => {
    await renderCard(
      row({
        state: "not-installed",
        status: { state: "not-installed", addresses: [], hints: [{ text: "Install Tailscale on this machine." }] },
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    expect(card.textContent).toContain("Install Tailscale on this machine.");
    // A lone "1." promises a second step that never comes.
    expect(card.textContent).not.toContain("1.Install Tailscale");
  });

  it("not-installed offers Install only where the server may run the command, and streams it", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/api/network/tailscale/install"
        ? ndjson({ type: "done", ok: true, exitCode: 0 }, ["fetching tailscale…"])
        : undefined,
    );
    await renderCard(
      row({ state: "not-installed", install: { command: "brew install tailscale", docsUrl: "https://ts.net" } }),
    );
    expect(screen.getByText(/Runs/).textContent).toContain("brew install tailscale");
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(calls.some((c) => c.pathname === "/api/network/tailscale/install")).toBe(true));
  });

  it("a daemon that is down renders the plugin's own hint and offers only Re-check", async () => {
    await renderCard(
      row({
        state: "daemon-down",
        status: {
          state: "daemon-down",
          addresses: [],
          hints: [{ text: "tailscaled is not running.", command: "sudo systemctl start tailscaled" }],
        },
      }),
    );
    // Verbatim: this page does not paraphrase what a plugin says about its
    // own daemon.
    expect(screen.getByText("tailscaled is not running.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Publish/ })).toBeNull();
  });

  it("numbers nothing at all on a daemon that is down, however many hints there are", async () => {
    // The shape the first shipped plugin emits: the platform's start command,
    // then the daemon's own first line of stderr explaining a case that
    // command does not fix. Numbering belongs to the `not-installed` row,
    // which is a sequence a person walks; these are the state of a machine
    // right now, and "2." in front of an explanation tells someone to go and
    // do something that is not a thing to do. The card passes no `startAt`
    // here, so there is nothing to get wrong — this pins that.
    await renderCard(
      row({
        state: "daemon-down",
        status: {
          state: "daemon-down",
          addresses: [],
          hints: [
            { text: "tailscaled is not running.", command: "sudo systemctl start tailscaled", privileged: true },
            { text: "failed to connect to local tailscaled; is it running?" },
          ],
        },
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    expect(card.textContent).toContain("failed to connect to local tailscaled; is it running?");
    expect(screen.queryByText("1.")).toBeNull();
    expect(screen.queryByText("2.")).toBeNull();
  });

  it("needs-privilege is the same shape as a daemon that is down — a hint and Re-check", async () => {
    await renderCard(
      row({
        state: "needs-privilege",
        status: {
          state: "needs-privilege",
          addresses: [],
          hints: [{ text: "This server may not talk to tailscaled.", privileged: true }],
        },
      }),
    );
    expect(screen.getByText("This server may not talk to tailscaled.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("needs-login takes a credential, never shows it, and Connect sends it", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/api/network/tailscale/join"
        ? ndjson({ type: "done", outcome: { state: "joined" }, status: { state: "joined", addresses: [], hints: [] } })
        : undefined,
    );
    await renderCard(row({ state: "needs-login" }));
    const field = screen.getByLabelText("Auth key") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "tskey-auth-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => {
      const join = calls.find((c) => c.pathname === "/api/network/tailscale/join");
      expect(join && JSON.parse(String(join.body))).toEqual({ credential: "tskey-auth-abc" });
    });
    // No addresses yet, so nothing to publish.
    expect(screen.queryByRole("button", { name: /^Publish/ })).toBeNull();
  });

  it("an interactive sign-in asks with an EMPTY body and renders the URL and code it comes back with", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/api/network/tailscale/join"
        ? ndjson({
            type: "done",
            outcome: { state: "needs-login", loginUrl: "https://login.tailscale.com/a/abc", loginCode: "WXYZ-1234" },
            status: { state: "needs-login", addresses: [], hints: [] },
          })
        : undefined,
    );
    await renderCard(row({ state: "needs-login" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Tailscale" }));
    await waitFor(() => expect(screen.getByText("https://login.tailscale.com/a/abc")).toBeTruthy());
    // Absence, never `credential: ""` — an empty body is what asks for the
    // interactive path.
    const join = calls.find((c) => c.pathname === "/api/network/tailscale/join");
    expect(join && JSON.parse(String(join.body))).toEqual({});
    expect(screen.getByText("WXYZ-1234")).toBeTruthy();
    expect(screen.getByText(/Open this link to finish signing in/)).toBeTruthy();
  });

  it("a plugin with no interactive path offers only the credential", async () => {
    await renderCard(row({ state: "needs-login", interactiveLogin: false }));
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
  });

  it("joined states what each address costs, and offers Publish rather than Unpublish", async () => {
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    expect(screen.getByText("Passkeys and secure cookies work at this address.")).toBeTruthy();
    expect(screen.getByText(/your browser sees plain http/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Publish/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
  });

  it("renders the addresses in the order the server sent them", async () => {
    // Load-bearing rather than cosmetic: the host promotes `addresses[0]`
    // when asked to set the base URL, so a plugin puts its https origin first
    // deliberately. Anything that re-sorted this list here — by scheme, by
    // secure context, by label — would leave the page showing one order while
    // the checkbox beneath it adopted another.
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    const shown = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(shown[0]).toContain("https://box.tail1234.ts.net");
    expect(shown[1]).toContain("http://100.64.0.1:3080");
  });

  it("the base-URL checkbox says what it costs and rides on the publish body", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/api/network/tailscale/publish"
        ? ndjson({
            type: "done",
            ok: true,
            addresses: ADDRESSES,
            config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
            restartRequired: false,
            status: { state: "published", addresses: ADDRESSES, hints: [] },
          })
        : undefined,
    );
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    expect(screen.getByText(/Passkeys registered at the current address stop working there/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Set as this server's base URL/));
    fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => {
      const call = calls.find((c) => c.pathname === "/api/network/tailscale/publish");
      expect(call && JSON.parse(String(call.body))).toEqual({ promoteBaseUrl: true });
    });
  });

  it("a joined network still says why an address is missing", async () => {
    // The gap this closes: hints used to stop at the door. A tailnet with no
    // certificates hands out no https address at all, and the list alone is
    // just quietly one address short with the reason nowhere on screen.
    await renderCard(
      row({
        state: "joined",
        status: {
          state: "joined",
          addresses: [ADDRESSES[1]],
          hints: [
            {
              text: "Enable HTTPS certificates in the admin console to get an https address.",
              docsUrl: "https://ts.net/https",
            },
          ],
        },
      }),
    );
    expect(screen.getByText("Enable HTTPS certificates in the admin console to get an https address.")).toBeTruthy();
    // Not numbered: this is a standing fact about the machine, not step one
    // of anything.
    const card = screen.getByRole("group", { name: "Tailscale" });
    expect(card.textContent).not.toContain("1.Enable HTTPS");
  });

  it("published offers Unpublish and Disconnect, and no second Publish", async () => {
    await renderCard(row({ state: "published", status: { state: "published", addresses: ADDRESSES, hints: [] } }));
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Publish/ })).toBeNull();
  });

  it("published shows the supervised process, including how the last run ended", async () => {
    await renderCard(
      row({
        state: "published",
        status: { state: "published", addresses: ADDRESSES, hints: [] },
        process: {
          running: false,
          restarts: 3,
          lastExit: { code: 1, at: new Date(Date.now() - 120_000).toISOString() },
          lastLines: ["tunnel closed: context canceled"],
        },
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    expect(card.textContent).toContain("Stopped");
    expect(card.textContent).toContain("3 restarts");
    expect(card.textContent).toContain("with code 1");
    expect(card.textContent).toContain("tunnel closed: context canceled");
  });
});

describe("NetworkPluginCard: the rules that are not about one state", () => {
  it("a secret setting reports whether it is set and never renders a value", async () => {
    await renderCard(
      row({
        state: "joined",
        status: { state: "joined", addresses: ADDRESSES, hints: [] },
        settingsFields: [{ key: "authKey", label: "Auth key", type: "secret", placeholder: "tskey-auth-…" }],
        // Exactly what the server sends in a secret's place — the value never
        // travels, so there is nothing here that COULD be echoed.
        settings: { authKey: { set: true } },
      }),
    );
    const field = screen.getByLabelText("Auth key") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.type).toBe("password");
    expect(screen.getByText(/Set — typing here replaces it\./)).toBeTruthy();
    // The caveat the page owns rather than the plugin: the backup snapshots
    // the database, and a plugin secret does not live there.
    expect(screen.getByText(/does not include it — after a restore, paste it again/)).toBeTruthy();
  });

  it("a refused publish renders the plugin's reason inline, not as an error", async () => {
    mockFetch((url) =>
      url.pathname === "/api/network/tailscale/publish"
        ? ndjson({
            type: "done",
            ok: false,
            refused: { text: "Enable HTTPS certificates in the admin console first.", docsUrl: "https://ts.net/https" },
            addresses: [],
            config: { changed: [], warnings: [], written: false },
            restartRequired: false,
            status: { state: "joined", addresses: ADDRESSES, hints: [] },
          })
        : undefined,
    );
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(screen.getByText("Enable HTTPS certificates in the admin console first.")).toBeTruthy());
    // The server answered correctly and said why not. An alert would call
    // that a failure of ours.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a publish that could not write config.env names the key the environment holds", async () => {
    mockFetch((url) =>
      url.pathname === "/api/network/tailscale/publish"
        ? ndjson({
            type: "done",
            ok: true,
            addresses: ADDRESSES,
            config: { changed: [], warnings: [], written: false, unwritableKey: "TRUSTED_ORIGINS" },
            restartRequired: false,
            status: { state: "published", addresses: ADDRESSES, hints: [] },
          })
        : undefined,
    );
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(screen.getByText(/was not written to config.env/)).toBeTruthy());
    expect(screen.getByText("TRUSTED_ORIGINS")).toBeTruthy();
  });

  /** Publish fails, then Disconnect succeeds — the fixture both halves share. */
  function failedPublishThenLeave() {
    return mockFetch((url) =>
      url.pathname === "/api/network/tailscale/publish"
        ? ndjson({ type: "error", message: "the daemon went away" })
        : url.pathname === "/api/network/tailscale/leave"
          ? Response.json({ ok: true, status: { state: "needs-login", addresses: [], hints: [] } })
          : undefined,
    );
  }

  const JOINED = row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } });

  it("a failed act says so", async () => {
    failedPublishThenLeave();
    await renderCard(JOINED);
    fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(screen.getByText(/the daemon went away/)).toBeTruthy(), { timeout: 1200 });
  });

  it("a later act clears the previous one's failure", async () => {
    // A mutation's result outlives the state it describes. The error banner
    // takes the first non-null error across all five mutations, and `begin()`
    // used to clear only the output line — so a failed act's message stayed on
    // screen through every act after it, including the ones that worked. The
    // publish announcement had the same shape: it renders outside every state
    // branch, so after Unpublish the card went on announcing a publish above a
    // row that had gone back to `joined`.
    //
    // **Split from the assertion above deliberately.** As one test this was
    // the only one in the file to fail in CI, four runs running, always as a
    // bare timeout with no assertion attached even once every await carried
    // its own budget — which says it was blocking rather than polling, and
    // that the thing blocking it was not any single step. Two tests give each
    // half its own budget and its own clean fixture, and make the next failure
    // name which half it is.
    failedPublishThenLeave();
    await renderCard(JOINED);
    fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(screen.getByText(/the daemon went away/)).toBeTruthy(), { timeout: 1200 });

    // A DIFFERENT mutation, which is the case that was broken: `leave` never
    // cleared `publish`'s error, so the card reported a failure that had
    // nothing to do with what it was now doing.
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect.hasAttribute("disabled")).toBe(false);
    fireEvent.click(disconnect);
    // Scoped to the dialog, which is what the two tests below already do. A
    // bare role query matches the CARD's Disconnect as well as the dialog's,
    // and whichever the query reached first decided the outcome.
    const dialog = await screen.findByRole("dialog", {}, { timeout: 1200 });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.queryByText(/the daemon went away/)).toBeNull(), { timeout: 1200 });
  });

  it("uses the vendor's own words for the credential and for publishing", async () => {
    // A generic word is WRONG rather than bland here: NetBird takes a setup
    // key and Cloudflare a tunnel token, so a field labelled "Auth key" on
    // either row asks for something that network does not have.
    await renderCard(row({ state: "needs-login", status: { state: "needs-login", addresses: [], hints: [] } }));
    expect(screen.getByLabelText("Auth key")).toBeTruthy();
    cleanup();
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    expect(screen.getByRole("button", { name: "Publish with Tailscale Serve" })).toBeTruthy();
  });

  it("falls back to a generic word when a plugin names none", async () => {
    await renderCard(
      row({ state: "joined", labels: {}, status: { state: "joined", addresses: ADDRESSES, hints: [] } }),
    );
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  });

  it("says the row is published, which survives a reload", async () => {
    // The post-publish block reports the last ACT and is cleared by the next
    // one, so after a reload an admin saw addresses and an Unpublish button
    // with nothing stating the row's status.
    await renderCard(
      row({ state: "published", published: true, status: { state: "published", addresses: ADDRESSES, hints: [] } }),
    );
    expect(screen.getByText("Subshell is published on Tailscale.")).toBeTruthy();
  });

  it("does not invite a settings edit the server would refuse", async () => {
    // The server refuses a settings write while published, because nothing
    // re-derives the guard, the argv or the hydrated secret from it. A form
    // that accepted the edit would put that explanation after the typing.
    await renderCard(
      row({
        state: "published",
        published: true,
        settingsFields: [{ key: "hostname", label: "Hostname", type: "string" }],
        settings: { hostname: "box.example.com" },
        status: { state: "published", addresses: ADDRESSES, hints: [] },
      }),
    );
    expect(screen.getByText(/Unpublish Tailscale to change these/)).toBeTruthy();
    expect((screen.getByLabelText("Hostname") as HTMLInputElement).disabled).toBe(true);
  });

  it("does not claim the file was untouched when part of the write landed", async () => {
    // `written` is false whenever ANY key was refused, so a publish that added
    // the trusted origin and could not promote the base URL used to say
    // "updated TRUSTED_ORIGINS" and "config.env was not changed" four lines
    // apart, about one write.
    mockFetch((url) =>
      url.pathname === "/api/network/tailscale/publish"
        ? ndjson({
            type: "done",
            ok: true,
            addresses: ADDRESSES,
            config: {
              changed: ["TRUSTED_ORIGINS"],
              warnings: ["APP_BASE_URL is set in the server's environment."],
              written: false,
              unwritableKey: "APP_BASE_URL",
            },
            restartRequired: true,
            status: { state: "published", addresses: ADDRESSES, hints: [] },
          })
        : undefined,
    );
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
    const line = await screen.findByText(/was not written to config.env/);
    // The KEY and the sentence in one element, so a split rendering cannot
    // pass this while showing the reader half of it.
    expect(line.textContent).toContain("APP_BASE_URL was not written to config.env");
    expect(screen.queryByText(/config.env was not changed/)).toBeNull();
  });

  it("a public-with-gate network says so permanently, above everything else", async () => {
    await renderCard(row({ exposure: "public-with-gate", state: "joined" }));
    expect(screen.getByText(/puts this server on the public internet with an identity check in front/)).toBeTruthy();
  });

  it("a private network carries no such note", async () => {
    await renderCard(row({ state: "joined" }));
    expect(screen.queryByText(/public internet/)).toBeNull();
  });

  it("disconnecting asks a question and sends the plugin id, which nobody types", async () => {
    const calls = mockFetch(() => undefined);
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    // The question names the network the person is looking at…
    expect(within(dialog).getByText("Disconnect this server from Tailscale?")).toBeTruthy();
    // …and nothing has gone to the server yet.
    expect(calls.some((c) => c.pathname.endsWith("/leave"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => {
      const leave = calls.find((c) => c.pathname === "/api/network/tailscale/leave");
      // The ID, programmatically. It is the path segment and a guaranteed
      // lowercase slug; the name on screen is "Tailscale", so a field asking
      // someone to type what they can see would fail on the capital alone.
      expect(leave && JSON.parse(String(leave.body))).toEqual({ confirm: "tailscale" });
    });
  });

  it("dismissing that question sends nothing", async () => {
    const calls = mockFetch(() => undefined);
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((c) => c.pathname.endsWith("/leave"))).toBe(false);
  });

  it("an install route that is not there leaves the hints standing", async () => {
    // A 404 means this plugin ships no installer — which is what the row is
    // already saying, in the steps beneath. An error line over them would
    // report a failure about the very thing that is on screen working.
    mockFetch((url) =>
      url.pathname === "/api/network/tailscale/install"
        ? new Response(JSON.stringify({ message: "no installer" }), { status: 404 })
        : undefined,
    );
    await renderCard(
      row({
        state: "not-installed",
        install: { command: "brew install tailscale", docsUrl: "https://ts.net" },
        status: {
          state: "not-installed",
          addresses: [],
          hints: [{ text: "Install it on this machine first.", command: "brew install tailscale" }],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByText("Install it on this machine first.")).toBeTruthy();
    expect(screen.queryByText(/The request failed/)).toBeNull();
  });

  it("the compact variant keeps every act and drops the chrome", async () => {
    await renderCard(
      row({
        state: "joined",
        status: { state: "joined", addresses: ADDRESSES, hints: [] },
        process: { running: true, pid: 99, restarts: 0, lastLines: ["up"] },
      }),
      true,
    );
    const item = screen.getByRole("listitem", { name: "Tailscale" });
    expect(within(item).getByRole("button", { name: /^Publish/ })).toBeTruthy();
    expect(within(item).getByRole("button", { name: "Disconnect" })).toBeTruthy();
    // The description and the supervisor detail are what `compact` drops —
    // first run is not where a person reads a pid.
    expect(item.textContent).not.toContain("A private network for your own devices.");
    expect(item.textContent).not.toContain("pid 99");
    // And the HEADER, name included: the caller renders it. Nothing here may
    // carry the plugin's name as its own text, or the wizard's row prints
    // "Tailscale" twice, once per component.
    expect(within(item).queryByText("Tailscale")).toBeNull();
  });
});

describe("hint numbering", () => {
  it("numbers only the hints that carry a command", async () => {
    // A plugin opens its not-installed list with a sentence saying what is
    // wrong, then the steps that fix it. Numbering the sentence tells the
    // reader to perform it, and pushes every real step one number along.
    await renderCard(
      row({
        privileged: [{ label: "Install the daemon", command: "sudo apt install meshtool" }],
        status: {
          state: "not-installed",
          addresses: [],
          hints: [
            { text: "Meshtool is not installed on this machine." },
            {
              text: "Allow this server to control Meshtool",
              command: "sudo meshtool set --operator=$USER",
              privileged: true,
            },
          ],
        },
      }),
    );
    // Two commands in the sequence, so both are numbered and the explanation
    // between them takes no number of its own.
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();
    expect(screen.queryByText("3.")).toBeNull();
  });

  it("numbers nothing when there is a single command", async () => {
    await renderCard(
      row({
        privileged: [],
        status: {
          state: "not-installed",
          addresses: [],
          hints: [
            { text: "Meshtool is not installed on this machine." },
            { text: "Install it", command: "brew install meshtool" },
          ],
        },
      }),
    );
    expect(screen.getByText("Install it")).toBeTruthy();
    expect(screen.queryByText("1.")).toBeNull();
  });

  it("numbers nothing when the single command is a privileged step", async () => {
    // The other half of the same rule. Both lists read ONE count, so they
    // cannot disagree about whether this row is a sequence — before that was
    // shared, the privileged list numbered itself unconditionally and a row
    // with exactly one step opened with a "1." standing on its own.
    await renderCard(
      row({
        privileged: [{ label: "Install the daemon", command: "brew install meshtool" }],
        status: { state: "not-installed", addresses: [], hints: [] },
      }),
    );
    expect(screen.getByText("Install the daemon")).toBeTruthy();
    expect(screen.queryByText("1.")).toBeNull();
  });
});

describe("NetworkPluginCard: a way back from every state that needs one", () => {
  // Installing the vendor's tool happens in a terminal — every step the card
  // shows is copy-only, because the server has no way to run a privileged
  // command — so the person leaves, does the work, and comes back. A state
  // that offers no Re-check makes reloading the page the only way to say so,
  // and a row still reporting "not installed" about a machine where it now IS
  // reads as the feature being broken rather than as stale.
  // `needs-login` is in this list for two reasons beyond the general one: a
  // plugin's hint there can legitimately say "turn it back on, then re-check"
  // (Tailscale's `Stopped` hint does, and a sentence pointing at a control
  // that is not on screen is worse than no sentence), and signing in finishes
  // on ANOTHER device, so the page needs a way to be told rather than only the
  // poll that runs while a login URL exists.
  const needsAWayBack: NetworkState[] = ["not-installed", "daemon-down", "needs-privilege", "needs-login"];

  for (const state of needsAWayBack) {
    it(`offers Re-check in ${state}`, async () => {
      await renderCard(
        row({
          state,
          privileged: [{ label: "Install it", command: "sudo apt install meshtool" }],
          status: { state, addresses: [], hints: [{ text: "Something is not right yet." }] },
        }),
      );
      expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
    });
  }

  // What Re-check DOES is invalidate the list query, which the page owns and
  // this component does not: the card takes its row as a prop. Asserting the
  // refetch here would be asserting TanStack Query's behaviour through a
  // component that never fetches.
});

describe("NetworkPluginCard: the disable reason reaches a screen reader", () => {
  it("associates the reason with every field rather than only placing it above", async () => {
    // A screen reader tabbing this form skips disabled inputs entirely, so a
    // bare paragraph is a reason the people most likely to be confused by the
    // disabled state never reach.
    await renderCard(
      row({
        state: "published",
        published: true,
        settingsFields: [{ key: "hostname", label: "Hostname", type: "string" }],
        settings: { hostname: "box.example.com" },
        status: { state: "published", addresses: ADDRESSES, hints: [] },
      }),
    );
    const field = screen.getByLabelText("Hostname");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain("Unpublish Tailscale to change these");
  });
});
