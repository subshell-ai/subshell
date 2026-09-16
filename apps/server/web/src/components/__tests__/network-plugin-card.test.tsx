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
import { NETWORK_QUERY_KEY } from "@/hooks/use-network";
import { PUBLIC_SETTINGS_QUERY_KEY } from "@/hooks/use-public-settings";
import { setFetchRouter } from "@/test-setup";
import type { NetworkRow, NetworkState, SettingsFieldWire } from "@/types/network";

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
    publishImplicit: false,
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

/**
 * Cloudflare's four settings fields, VERBATIM from
 * `packages/plugins/cloudflare-tunnel/src/settings.ts`.
 *
 * The credential box's placeholder is looked up from exactly this shape, and
 * the wizard's one-door rule is decided by exactly this mix of required
 * non-secrets and one required secret — a fixture that invented its own field
 * would be testing a plugin that does not exist.
 */
const CLOUDFLARE_FIELDS: SettingsFieldWire[] = [
  {
    key: "hostname",
    type: "string",
    required: true,
    label: "Hostname",
    placeholder: "subshell.example.com",
    description:
      "The public hostname the tunnel answers on. Its DNS record and its Access application are created in the Cloudflare dashboard; publishing is refused until Access covers it.",
  },
  {
    key: "teamDomain",
    type: "string",
    required: true,
    label: "Access team domain",
    placeholder: "myteam",
    description: "Your Cloudflare Access team. Assertions are verified against <team>.cloudflareaccess.com.",
  },
  {
    key: "aud",
    type: "string",
    required: true,
    label: "Access application Audience tag",
    description:
      "The AUD tag of the Access application that guards this hostname. It is in that application's summary, and every assertion is verified against it.",
  },
  {
    key: "tunnel-token",
    type: "secret",
    required: true,
    label: "Tunnel token",
    placeholder: "Paste it from Zero Trust → Networks → Tunnels → the tunnel's connector",
    description: "It reaches the tunnel through the connector's own environment, never a command line.",
  },
];

/** A needs-login cloudflare row, in the shape the wire actually carries. */
function cloudflareRow(over: Partial<NetworkRow> & { state?: NetworkState } = {}): NetworkRow {
  return row({
    id: "cloudflare-tunnel",
    name: "Cloudflare Tunnel",
    labels: { credential: "Tunnel token", publish: "Start tunnel" },
    settingsFields: CLOUDFLARE_FIELDS,
    exposure: "public-with-gate",
    // Verbatim from `packages/plugins/cloudflare-tunnel/package.json`, which is
    // what this fixture is for. It used to inherit `interactiveLogin: true`
    // from the Tailscale-shaped base and nothing noticed — on the pre-choice
    // card that flag only added a Sign-in button no Cloudflare test asserted
    // the absence of. Under the mode choice it decides whether the card offers
    // a choice AT ALL, so an inherited value would be testing a plugin that
    // does not exist.
    interactiveLogin: false,
    ...over,
  });
}

/**
 * Renders the card inside a throwaway router + query client (it uses both).
 *
 * The client is returned, not swallowed: the restart waiter's whole contract
 * is what it INVALIDATES when the server comes back, and a card test can only
 * observe that through the one client the tree is mounted on.
 */
async function renderCard(value: NetworkRow, compact = false): Promise<QueryClient> {
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
  return client;
}

/**
 * Switches an interactive row's `needs-login` card to its credential panel.
 *
 * The card opens on the sign-in panel, so every test that wants the key box
 * has to ask for it — which is the point of the mode choice, and why this is
 * one named line rather than a click each test forgets.
 */
function showKeyPanel(label = "Use auth key"): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/**
 * The bordered box that scopes a mode choice to the panel beneath it.
 *
 * Located through `.join-group`, a utility-like hook the component carries
 * beside the real classes (the repo's own `overflow-y-auto` precedent). The
 * alternative was reading `className` for `rounded-md` and `p-4`, which passes
 * the day a restyle keeps the box and fails the day it earns one — and the box
 * is the point: the operator's read of the live card was a pill strip floating
 * above orphaned text.
 */
function modeGroups(): Element[] {
  return Array.from(document.querySelectorAll(".join-group"));
}

/** An NDJSON stream: some progress, then one terminal frame. */
function ndjson(done: unknown, lines: string[] = []): Response {
  const body = [...lines.map((text) => JSON.stringify({ type: "line", text })), JSON.stringify(done)].join("\n");
  return new Response(body, { status: 200 });
}

/** Routes every request this card can make; records what went out. */
function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
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

  it("not-installed renders grouped steps as ALTERNATIVES, with an `or` between them", async () => {
    // The macOS Tailscale row: an app route of one step and a daemon route of
    // two. Numbered as one sequence, the card told a person to install the app
    // AND the daemon AND grant the operator — three steps where the first
    // makes the other two pointless. The group is what says "or".
    await renderCard(
      row({
        state: "not-installed",
        privileged: [
          {
            label: "Install the app",
            command: "brew install --cask tailscale-app",
            group: "The Tailscale app (recommended)",
          },
          { label: "Install the daemon", command: "brew install --formula tailscale", group: "The daemon" },
          {
            label: "Allow this server to control Tailscale",
            command: "sudo tailscale set --operator=$USER",
            group: "The daemon",
          },
        ],
        status: { state: "not-installed", addresses: [], hints: [] },
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    const text = card.textContent ?? "";
    // Groups appear in first-appearance order, with ONE `or` line BETWEEN them
    // — after the first route's steps, before the second route's heading.
    const appHeading = screen.getByText("The Tailscale app (recommended)");
    const daemonHeading = screen.getByText("The daemon");
    const ors = screen.getAllByText("or");
    expect(ors).toHaveLength(1);
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(appHeading, ors[0] as Element)).toBe(true);
    expect(follows(ors[0] as Element, daemonHeading)).toBe(true);
    // Numbering restarts inside a group, and a group of one is not numbered —
    // a lone "1." under a heading promises a second step that never comes.
    expect(text).toContain("Install the app");
    expect(text).not.toContain("1.Install the app");
    expect(text).toContain("1.Install the daemon");
    expect(text).toContain("2.Allow this server to control Tailscale");
    // Still copy-only, and every command rendered exactly once.
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBe(3);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("does not run a hint's number on from a grouped sequence", async () => {
    // A continued number would belong to no group: "3." after a two-step
    // daemon route reads as a third step of that route, when the hint is the
    // plugin speaking about the machine rather than about either route.
    await renderCard(
      row({
        state: "not-installed",
        privileged: [
          { label: "Install the app", command: "brew install --cask tailscale-app", group: "The app" },
          { label: "Install the daemon", command: "brew install --formula tailscale", group: "The daemon" },
        ],
        status: {
          state: "not-installed",
          addresses: [],
          hints: [{ text: "Tailscale is not installed on this machine." }],
        },
      }),
    );
    const text = screen.getByRole("group", { name: "Tailscale" }).textContent ?? "";
    expect(text).toContain("Tailscale is not installed on this machine.");
    expect(text).not.toContain("2.Install the daemon");
    expect(text).not.toMatch(/\d+\./);
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
    showKeyPanel();
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

  it("how to join is a CHOICE, and the unused path's box is not on screen", async () => {
    // The defect this closes, reported from the live Headscale card: the auth
    // key box — the OPTIONAL path's credential — was a big empty field at the
    // top of the card, with "Connect" and "Sign in with Headscale" as sibling
    // buttons under it. An empty box above two buttons reads as a required
    // field, and two buttons side by side read as related acts on one form
    // rather than as one-or-the-other. Now one control carries the choice and
    // exactly one panel sits under it.
    await renderCard(
      row({
        id: "headscale",
        name: "Headscale",
        state: "needs-login",
        status: { state: "needs-login", addresses: [], hints: [] },
      }),
    );
    // Sign-in is the default: the human sitting at this page is the common
    // case, a pasted key what an automation or a headless host brings.
    const signIn = screen.getByRole("button", { name: "Sign in with Headscale" });
    expect(signIn).toBeTruthy();
    expect(screen.getByText(/Asks Headscale for a sign-in link/)).toBeTruthy();
    // The other path is ABSENT, not greyed — that absence is the fix.
    expect(screen.queryByLabelText("Auth key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    // The choice itself is the app's `Segmented`, not a new primitive — and it
    // HUGS its two labels. Every other use of that control sizes to its
    // content; stretched card-wide with both buttons at one end it read as a
    // tab bar for a page with no other pages.
    const segmented = screen.getByRole("group", { name: "How to connect" });
    expect(segmented.className).toContain("w-fit");
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      (screen.getByRole("button", { name: "Use auth key" }) as HTMLButtonElement).getAttribute("aria-pressed"),
    ).toBe("false");

    // ONE UNIT, not a strip floating above orphaned text — the operator's
    // second read of the same card. The control and the panel under it share
    // one border, and exactly one such box exists on the row.
    const groups = modeGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.contains(segmented)).toBe(true);
    expect(groups[0]?.contains(screen.getByRole("button", { name: "Sign in with Headscale" }))).toBe(true);
    // No visible caption above the pills: the fieldset already names the group
    // for a screen reader, so a heading saying it again is those words twice.
    expect(screen.queryByText("How to connect")).toBeNull();

    showKeyPanel();
    expect(screen.getByLabelText("Auth key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with Headscale" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Use auth key" }) as HTMLButtonElement).getAttribute("aria-pressed"),
    ).toBe("true");
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // The panels swap INSIDE the box, which stays the only one on the row.
    expect(modeGroups()).toHaveLength(1);
    expect(groups[0]?.contains(screen.getByLabelText("Auth key"))).toBe(true);
    expect(groups[0]?.contains(screen.getByRole("button", { name: "Connect" }))).toBe(true);
  });

  it("a single-path plugin is offered no choice", async () => {
    // Cloudflare Tunnel has no interactive path, so a fork on its card would
    // draw a road that does not exist. Its block renders as it did before the
    // mode choice: box, Connect — and one sentence, not a panel switch.
    await renderCard(cloudflareRow({ state: "needs-login" }));
    expect(screen.queryByRole("group", { name: "How to connect" })).toBeNull();
    // Nothing to scope, so no box: the border is what groups a CHOICE with what
    // it chooses, and a single path has one thing to do.
    expect(modeGroups()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Use tunnel token" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
    // Box and Connect button are simply there, with no panel to switch to.
    // The exact string names ONLY the box — the settings form's other door
    // reads "Tunnel token (required)" (see the two-doors test below), which is
    // what makes this assertion about the credential box rather than about
    // whichever of the two came first.
    expect(screen.getByLabelText("Tunnel token")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("a plugin with no interactive path offers only the credential", async () => {
    await renderCard(row({ state: "needs-login", interactiveLogin: false }));
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
  });

  it("a login URL that arrives is shown whichever panel is up", async () => {
    // The URL comes from the join stream OR the poll, and a person who clicked
    // over to the key panel mid-sign-in must not lose the link they were told
    // about — the sign-in panel's second sentence points at this block.
    const status = {
      state: "needs-login" as const,
      addresses: [],
      hints: [],
      loginUrl: "https://login.tailscale.com/a/abc",
      loginCode: "WXYZ-1234",
    };
    await renderCard(row({ state: "needs-login", status }));
    expect(screen.getByText("https://login.tailscale.com/a/abc")).toBeTruthy();
    showKeyPanel();
    expect(screen.getByText("https://login.tailscale.com/a/abc")).toBeTruthy();
    expect(screen.getByText("WXYZ-1234")).toBeTruthy();
  });

  it("the credential box links the vendor page where the key is minted", async () => {
    // The box asked for an "Auth key" with nothing on the card saying what
    // one is or where to get it. The manifest's `credentialDocsUrl` answers
    // that on the label row.
    await renderCard(
      row({
        state: "needs-login",
        labels: { credential: "Auth key", credentialDocsUrl: "https://tailscale.com/kb/1085/auth-keys" },
      }),
    );
    showKeyPanel();
    const docs = screen.getByRole("link", { name: "Docs ↗" }) as HTMLAnchorElement;
    expect(docs.href).toBe("https://tailscale.com/kb/1085/auth-keys");
    expect(docs.getAttribute("rel")).toBe("noreferrer");
    // The Label still names the INPUT — the link rides beside it, it does
    // not replace it.
    expect(screen.getByLabelText("Auth key").id).toBe("network-tailscale-credential");
  });

  it("no Docs link when the plugin names no page, or names one a browser must not open", async () => {
    // Absence renders nothing rather than a dead anchor — and the sink keeps
    // its own check even though the manifest parser already refused this URL
    // at load: this field crosses the wire, and `safeHref` is the layer that
    // cannot be bypassed by anything upstream.
    await renderCard(row({ state: "needs-login" }));
    showKeyPanel();
    expect(screen.queryByRole("link", { name: "Docs ↗" })).toBeNull();
    cleanup();
    await renderCard(
      row({ state: "needs-login", labels: { credential: "Auth key", credentialDocsUrl: "javascript:alert(1)" } }),
    );
    showKeyPanel();
    expect(screen.queryByRole("link", { name: "Docs ↗" })).toBeNull();
  });

  it("the blocker gates BOTH join paths, in BOTH panels", async () => {
    // Headscale's real shape: one required non-secret. The route answers a
    // join on an unset one with 409 NETWORK_UNCONFIGURED and a sentence
    // pointing at the page the press came from — so the buttons wait instead,
    // each carrying the reason through aria-describedby (disabled controls are
    // skipped by a screen reader's tab order, so placement is not reaching).
    //
    // It is the SERVER's refusal, not one panel's, so the mode choice cannot
    // put it under one button and leave the other unexplained: the sentence
    // sits directly under the choice and survives switching panels.
    await renderCard(
      row({
        id: "headscale",
        name: "Headscale",
        state: "needs-login",
        settingsFields: [
          {
            key: "controlUrl",
            label: "Control server URL",
            type: "string",
            required: true,
            placeholder: "https://headscale.example.com",
          },
        ],
      }),
    );
    const sentence = screen.getByText("Save the Control server URL first.");
    const signIn = screen.getByRole("button", { name: "Sign in with Headscale" }) as HTMLButtonElement;
    expect(signIn.disabled).toBe(true);
    expect(signIn.getAttribute("aria-describedby")).toBe(sentence.id);

    showKeyPanel();
    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    expect(connect.getAttribute("aria-describedby")).toBe(sentence.id);
    // ONE paragraph for both panels — a second copy would be two ids and a
    // screen reader reading the same refusal twice. And it sits INSIDE the
    // group, because the sentence explains the choice rather than one panel.
    expect(screen.getAllByText("Save the Control server URL first.")).toHaveLength(1);
    expect(modeGroups()[0]?.contains(sentence)).toBe(true);
  });

  it("the same row unblocks once the field is set", async () => {
    // The other half: the gate is the SERVER's rule, not a permanent "this
    // plugin needs settings" notice. With the value stored, the join is
    // offerable and nothing explains an absence.
    await renderCard(
      row({
        id: "headscale",
        name: "Headscale",
        state: "needs-login",
        settingsFields: [{ key: "controlUrl", label: "Control server URL", type: "string", required: true }],
        settings: { controlUrl: "https://headscale.example.com" },
      }),
    );
    expect(screen.queryByText(/Save the Control server URL first./)).toBeNull();
    expect((screen.getByRole("button", { name: "Sign in with Headscale" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the wizard asks for the token ONCE: the credential box is the secret's door", async () => {
    // Two inputs labelled "Tunnel token" was the defect. The join gate exempts
    // required SECRETS because joining is the act that delivers them, so the
    // settings form's secret row is a question the wizard asks twice — and the
    // box is the door this act actually writes through.
    await renderCard(cloudflareRow({ state: "needs-login" }), true);
    expect(screen.getAllByLabelText(/Tunnel token/)).toHaveLength(1);
    // The required NON-secrets stay: dropping one would leave a Connect button
    // nothing on screen can satisfy.
    expect(screen.getByLabelText(/^Hostname/)).toBeTruthy();
  });

  it("the full card keeps both token doors and says which the act writes", async () => {
    await renderCard(cloudflareRow({ state: "needs-login" }));
    // Two doors, one credential: the settings row replaces what is stored, the
    // box delivers the first one.
    const doors = screen.getAllByLabelText(/Tunnel token/);
    expect(doors).toHaveLength(2);
    expect(screen.getByText("To connect for the first time, paste it into the Connect box below.")).toBeTruthy();
    // The second is the credential box (the settings form renders above the
    // state branch), and the placeholder lookup resolves through the plugin's
    // real field — the one sentence telling an admin where to copy the token.
    expect((doors[1] as HTMLInputElement).getAttribute("placeholder")).toBe(
      "Paste it from Zero Trust → Networks → Tunnels → the tunnel's connector",
    );
  });

  it("joined states what each address costs, and offers Publish rather than Unpublish", async () => {
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    expect(screen.getByText("Passkeys and secure cookies work at this address.")).toBeTruthy();
    expect(screen.getByText(/your browser sees plain http/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Publish/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
  });

  it("names each identity fact, rather than joining them into one line", async () => {
    // The defect this closes: `suteki.nu · MacBook Pro · 1.102.4` put three
    // facts about three different things in one muted sentence, so nothing on
    // screen said which part was the network and which was a version number.
    await renderCard(
      row({
        state: "joined",
        status: {
          state: "joined",
          addresses: ADDRESSES,
          hints: [],
          identity: { network: "suteki.nu", hostname: "MacBook Pro", version: "1.102.4" },
        },
      }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    expect(within(card).getByText("Network", { selector: "dt" })).toBeTruthy();
    expect(within(card).getByText("suteki.nu")).toBeTruthy();
    expect(within(card).getByText("Machine", { selector: "dt" })).toBeTruthy();
    expect(within(card).getByText("MacBook Pro")).toBeTruthy();
    expect(within(card).getByText("Client version", { selector: "dt" })).toBeTruthy();
    expect(within(card).getByText("1.102.4")).toBeTruthy();
    // The addresses are their own section now, and the card says so.
    expect(within(card).getByRole("heading", { name: "Addresses" })).toBeTruthy();
  });

  it("labels only the identity parts the network reported", async () => {
    // A plugin's identity is partial in the general case; the joined line used
    // to drop an absent part silently, and a labelled "Machine:" over nothing
    // would be louder about the gap than the gap itself.
    await renderCard(
      row({ state: "joined", status: { state: "joined", addresses: [], hints: [], identity: { hostname: "box-1" } } }),
    );
    const card = screen.getByRole("group", { name: "Tailscale" });
    expect(within(card).getByText("Machine", { selector: "dt" })).toBeTruthy();
    expect(within(card).queryByText("Network", { selector: "dt" })).toBeNull();
    expect(within(card).queryByText("Client version", { selector: "dt" })).toBeNull();
    // No facts beyond the one, no addresses: no empty frame above the hints.
    expect(within(card).queryByRole("heading", { name: "Addresses" })).toBeNull();
  });

  it("says what joined means, above the button that changes it", async () => {
    // Both halves of this state now answer the standing question in the same
    // slot. Joined had no sentence at all — a person met a Publish button and
    // had to already know that joining put the MACHINE on the network while
    // publishing is what puts the DASHBOARD on it. The act is named in the
    // button's own words, so this row — whose label is Tailscale's — reads
    // “Publish with Tailscale Serve”, not a word the plugin never used.
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    expect(
      screen.getByText(
        "Subshell is not published on Tailscale yet — “Publish with Tailscale Serve” is what lets your other devices open this dashboard over the network.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Publish/ })).toBeTruthy();
    expect(screen.queryByText("Subshell is published on Tailscale.")).toBeNull();
  });

  it("gives publishing its own section, and answers whether it is needed", async () => {
    // The operator read: a joined card flowed facts, sentence, hints and the
    // publish button as one column, and nothing said whether pressing it was
    // required. The act now sits under its own heading, and the section states
    // the case where skipping is honest — this machine only, or addresses the
    // server already allows.
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    expect(screen.getByRole("heading", { name: "Publish" })).toBeTruthy();
    expect(
      screen.getByText(
        "You can skip this while you only use Subshell on this machine, or at an address you have already allowed.",
      ),
    ).toBeTruthy();
  });

  it("an implicit-publish network's joined row is a gap: one line and the button, no section", async () => {
    // JOIN IS THE PUBLISH (spec §5.3, amended 2026-09-16): the join route
    // records the publish itself, so a row STILL saying `joined` is only ever
    // the gap — a manual `netbird up`, a sign-in finished in another tab, the
    // half-second an address table takes to settle. The fallback is one
    // sentence and the plugin's own word under it, with no heading, no skip
    // paragraph and none of the cost an explicit press really carries.
    await renderCard(
      row({
        id: "netbird",
        name: "NetBird",
        publishImplicit: true,
        labels: { credential: "Setup key", publish: "Use this address" },
        state: "joined",
        status: { state: "joined", addresses: ADDRESSES, hints: [] },
      }),
    );
    expect(screen.getByText(/NetBird publishes by joining/)).toBeTruthy();
    expect(screen.getByText(/“Use this address” records its addresses/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this address" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Other devices" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Publish" })).toBeNull();
    expect(screen.queryByText(/You can skip this/)).toBeNull();
    expect(screen.queryByText(/is not published on/)).toBeNull();
  });

  it("keeps the gap line and its button when the address table never settled", async () => {
    // The route's one re-read is not a poll; a row that stays address-less
    // stays the fallback, and the press is what records once they answer.
    await renderCard(
      row({
        id: "netbird",
        name: "NetBird",
        publishImplicit: true,
        labels: { credential: "Setup key", publish: "Use this address" },
        state: "joined",
        status: { state: "joined", addresses: [], hints: [] },
      }),
    );
    expect(screen.getByText(/publishes by joining/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this address" })).toBeTruthy();
  });

  it("asks no publish question of a published row", async () => {
    // The published state's standing line is a FACT among the card's readout,
    // not an opt-in: a "Publish" heading and a skip-it sentence over an
    // already-published row would re-ask a decided question.
    await renderCard(
      row({ state: "published", published: true, status: { state: "published", addresses: ADDRESSES, hints: [] } }),
    );
    expect(screen.queryByRole("heading", { name: "Publish" })).toBeNull();
    expect(screen.queryByText(/You can skip this/)).toBeNull();
  });

  it("names the act by the label the button under it actually carries", async () => {
    // The defect: the sentence said "publishing" while the button said
    // something else — NetBird's "Use this address" made an operator ask how to
    // publish. One expression feeds both, so a plugin's own vocabulary is what
    // the reader is told to press, and a plugin that names no label still gets
    // the fallback in both places.
    const netbird = row({
      id: "netbird",
      name: "NetBird",
      state: "joined",
      labels: { credential: "Setup key", publish: "Use this address" },
      status: { state: "joined", addresses: ADDRESSES, hints: [] },
    });
    await renderCard(netbird);
    expect(
      screen.getByText(
        "Subshell is not published on NetBird yet — “Use this address” is what lets your other devices open this dashboard over the network.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this address" })).toBeTruthy();
    cleanup();

    await renderCard(
      row({ state: "joined", labels: {}, status: { state: "joined", addresses: ADDRESSES, hints: [] } }),
    );
    expect(
      screen.getByText(
        "Subshell is not published on Tailscale yet — “Publish” is what lets your other devices open this dashboard over the network.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  });

  it("labels each address above its value, in the QUIET data-label grammar", async () => {
    // Two defects, in order, both from the same operator's live card. First the
    // tag-after-URL row (`http://…   MagicDNS name`) read as two disjoint
    // things, because a small muted word after a big bold URL names nothing
    // until you scan back — so the label moved ABOVE the value. Then the
    // grammar it moved into was the wrong one: the form label's `font-strong
    // text-label` put a bold "MagicDNS name" over its URL while the `Fact`
    // rows above it set a quiet "Client version" over theirs, and a card
    // holding both grammars reads as two systems. These are read-only facts, so
    // the label carries `Fact`'s `dt` classes — quiet colour, no weight token,
    // and the body size from the LIST, exactly as the `<dl>` supplies it.
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    const items = screen.getAllByRole("listitem");
    const first = items[0] as HTMLElement;
    expect(first.children[0]?.textContent).toBe("MagicDNS name");
    expect(first.children[0]?.className).toContain("text-muted-foreground");
    expect(first.children[0]?.className).not.toContain("font-strong");
    expect(first.children[0]?.className).not.toContain("text-label");
    // The size comes from the list so it cannot drift from the `<dl>` beside it.
    expect(first.parentElement?.className).toContain("text-sm");
    expect(first.children[1]?.textContent).toContain("https://box.tail1234.ts.net");
    // The secure-context sentence keeps its own line below the value, and it
    // is still the address's own — one per address, comparative by repetition.
    expect(first.children[2]?.textContent).toBe("Passkeys and secure cookies work at this address.");
    const second = items[1] as HTMLElement;
    expect(second.children[0]?.textContent).toBe("Tailscale IP");
  });

  it("renders the addresses in the order the server sent them", async () => {
    // The plugin's order is its own decision — tailscale puts its https
    // origin first — and this page prints the list it was handed. Re-sorting
    // here by scheme, by secure context or by label would make the page
    // contradict its own data for a reason no reader can see.
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    const shown = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(shown[0]).toContain("https://box.tail1234.ts.net");
    expect(shown[1]).toContain("http://100.64.0.1:3080");
  });

  it("offers to copy every address, joined ones included", async () => {
    // The copy button used to arrive only with `published`, on a prop that
    // called an unpublished address "a preview". A joined mesh address
    // ANSWERS — the sign-in is what refuses, not the connection — so it is
    // exactly the string a person takes to their phone, and a state that
    // hides the affordance made them hunt for a difference that was not there.
    await renderCard(row({ state: "joined", status: { state: "joined", addresses: ADDRESSES, hints: [] } }));
    expect(screen.getAllByRole("button", { name: /copy/i }).length).toBe(ADDRESSES.length);
  });

  it("publishes with a plain empty body", async () => {
    // The publish body is empty now that promoting the base URL is gone —
    // the field was the body's only member, and the route declares none.
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
    fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
    await waitFor(() => {
      const call = calls.find((c) => c.pathname === "/api/network/tailscale/publish");
      expect(call && JSON.parse(String(call.body))).toEqual({});
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
    // Through cloudflare's REAL field rather than an invented one — the
    // credential box's placeholder, the wizard's one-door rule and the
    // disconnect prompt's credential sentence all key off the exact shape a
    // manifest actually ships, so a fixture with its own fake `authKey` would
    // prove nothing about any of them.
    await renderCard(
      cloudflareRow({
        state: "joined",
        status: { state: "joined", addresses: ADDRESSES, hints: [] },
        // Exactly what the server sends in a secret's place — the value never
        // travels, so there is nothing here that COULD be echoed.
        settings: { "tunnel-token": { set: true } },
      }),
    );
    // Regex, not the exact text: a required field's label carries
    // "(required)" after the name, which an exact match reads as a
    // different label.
    const field = screen.getByLabelText(/^Tunnel token/) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.type).toBe("password");
    expect(field.getAttribute("placeholder")).toBe(
      "Paste it from Zero Trust → Networks → Tunnels → the tunnel's connector",
    );
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
    // either row asks for something that network does not have. The mode
    // choice takes the same word — "Use setup key", not a generic "Use key" —
    // so the panel and the option name the same thing.
    await renderCard(
      row({
        id: "netbird",
        name: "NetBird",
        state: "needs-login",
        labels: { credential: "Setup key", publish: "Use this address" },
        status: { state: "needs-login", addresses: [], hints: [] },
      }),
    );
    expect(screen.getByRole("button", { name: "Use setup key" })).toBeTruthy();
    showKeyPanel("Use setup key");
    expect(screen.getByLabelText("Setup key")).toBeTruthy();
    cleanup();
    await renderCard(row({ state: "needs-login", status: { state: "needs-login", addresses: [], hints: [] } }));
    showKeyPanel();
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
    // One slot, two halves: the joined sentence has no place here.
    expect(screen.queryByText(/is not published on/)).toBeNull();
  });

  it("unpublishing an implicit-publish network names what ends, and in which order", async () => {
    // The reversal (spec § 5.3, REVERSED 2026-09-16): NetBird has no vendor
    // mechanism to stop — membership is what makes its addresses answer — so
    // the dialog names what ACTUALLY ends, the server's permission to sign in
    // over them, and says so in the real order: sign-in stops at the restart,
    // the addresses go on answering while the machine stays a member, and
    // "Disconnect" is the act that ends them.
    await renderCard(
      row({
        id: "netbird",
        name: "NetBird",
        state: "published",
        published: true,
        publishImplicit: true,
        status: { state: "published", addresses: ADDRESSES, hints: [] },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        'Unpublishing NetBird takes its addresses out of the trusted origins when the server restarts, and sign-in from them stops then — the addresses themselves keep answering while this machine stays a member, because membership is what makes them answer. "Disconnect" takes the machine off the network.',
      ),
    ).toBeTruthy();
    // It promises no shutdown of the address itself.
    expect(within(dialog).queryByText(/the address itself stops answering/)).toBeNull();
  });

  it("unpublishing a serve-style network names what stops, and in which order", async () => {
    // The other kind: the record names the mechanism, so the published
    // addresses DO go down — and the origins now leave with the publish
    // (spec § 5.4, amended 2026-09-16), which means SIGN-IN can stop before
    // the address itself does (a mesh IP in the same list answers on
    // membership and keeps answering). The sentence states that order.
    await renderCard(
      row({ state: "published", published: true, status: { state: "published", addresses: ADDRESSES, hints: [] } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "The published addresses stop answering — addresses the network routes to this machine directly keep answering while it stays a member. This machine stays on the network; the addresses this publish trusted leave the trusted origins when the server restarts, and sign-in from them stops then — before the address itself may stop answering.",
      ),
    ).toBeTruthy();
  });

  // — the unpublish RESULT and the restart it can take (batch 3): the
  // subtraction's four answers, and one button wired to the Service page's
  // own dialog, waiter and pane-safety copy.

  it("a successful unpublish names what it removed and restarts from the result", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/api/network/tailscale/unpublish"
        ? Response.json({
            ok: true,
            config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
            restartRequired: true,
            origins: ["https://box.tail1234.ts.net"],
            status: { state: "joined", addresses: ADDRESSES, hints: [] },
          })
        : undefined,
    );
    await renderCard(
      row({ state: "published", published: true, status: { state: "published", addresses: ADDRESSES, hints: [] } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));

    expect(
      await screen.findByText("Asked to remove https://box.tail1234.ts.net from the trusted origins"),
    ).toBeTruthy();
    expect(screen.getByText("Restart the server to apply the change.")).toBeTruthy();

    // The button opens the Service page's own dialog — one voice about the
    // cost, not a second copy of the reasoning — and the ordinary
    // (`paneSafety: "keeps"`) definition confirms without `force`.
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Running subshells keep running; open terminals reconnect in a few seconds."),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart server" }));
    await waitFor(() => {
      const press = calls.find((c) => c.method === "POST" && c.pathname === "/api/admin/server/restart");
      expect(press).toBeTruthy();
      expect(JSON.parse(String(press?.body))).toEqual({});
    });
  });

  it("a join that published reports the write and restarts from there", async () => {
    // The join's own done frame carries the config write for a
    // `publishImplicit` network, so the card answers the restart from the
    // join — the same block, and the same single waiter, as a press on the
    // publish route. Nothing here re-reads the vendor: the stream answered.
    mockFetch((url) =>
      url.pathname === "/api/network/netbird/join"
        ? ndjson(
            {
              type: "done",
              outcome: { state: "joined" },
              status: { state: "published", addresses: ADDRESSES, hints: [] },
              config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
              restartRequired: true,
            },
            ["Joining NetBird…"],
          )
        : undefined,
    );
    await renderCard(
      row({
        id: "netbird",
        name: "NetBird",
        publishImplicit: true,
        labels: { credential: "Setup key", publish: "Use this address" },
        state: "needs-login",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in with NetBird" }));
    expect(await screen.findByText(/Published on NetBird/)).toBeTruthy();
    expect(screen.getByText(/updated TRUSTED_ORIGINS/)).toBeTruthy();
    expect(screen.getByText("Restart the server to apply the new address.")).toBeTruthy();
  });

  it("a leave that stripped says what left and offers the restart", async () => {
    // NetBird's NORMAL strip path is the Disconnect press — no unpublish
    // button involved — so the leave result must render the same trio block
    // with the removal-worded notice, or the restart that lands NetBird's
    // own origin strip would have no button anywhere.
    mockFetch((url) =>
      url.pathname === "/api/network/netbird/leave"
        ? Response.json({
            ok: true,
            config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
            restartRequired: true,
            origins: ["http://nb.disaresta.internal"],
            status: { state: "needs-login", addresses: [], hints: [] },
          })
        : undefined,
    );
    await renderCard(
      row({
        id: "netbird",
        name: "NetBird",
        publishImplicit: true,
        state: "joined",
        status: { state: "joined", addresses: ADDRESSES, hints: [] },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByText("Left NetBird; asked to remove http://nb.disaresta.internal from the trusted origins"),
    ).toBeTruthy();
    expect(screen.getByText("Restart the server to apply the change.")).toBeTruthy();
  });

  it("a pane-killing definition confirms with force, naming the cost", async () => {
    // The notice's Restart button opens the Service page's OWN dialog, so a
    // definition without `KillMode=process` — one that SIGKILLs every live
    // tmux pane with the process — gets the Service page's warning and the
    // `force: true` the route demands, not a second copy of either.
    const view = deploymentView();
    view.service.paneSafety = "kills";
    const calls = mockFetch((url) =>
      url.pathname === "/api/network/tailscale/unpublish"
        ? Response.json({
            ok: true,
            config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
            restartRequired: true,
            origins: ["https://box.tail1234.ts.net"],
            status: { state: "joined", addresses: ADDRESSES, hints: [] },
          })
        : url.pathname === "/api/admin/server"
          ? Response.json(view)
          : undefined,
    );
    await renderCard(
      row({ state: "published", published: true, status: { state: "published", addresses: ADDRESSES, hints: [] } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await screen.findByText("Asked to remove https://box.tail1234.ts.net from the trusted origins");

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    dialog = await screen.findByRole("dialog");
    // The cost stated in the Service page's words, and the forced press.
    expect(within(dialog).getByText(/will close every running subshell/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart anyway" }));
    await waitFor(() => {
      const press = calls.find((c) => c.method === "POST" && c.pathname === "/api/admin/server/restart");
      expect(JSON.parse(String(press?.body))).toEqual({ force: true });
    });
  });

  it("renders no restart button where the server cannot restart itself", async () => {
    const view = deploymentView();
    view.restart = { available: false, reason: "This server is not running under a service manager." };
    mockFetch((url) =>
      url.pathname === "/api/network/tailscale/unpublish"
        ? Response.json({
            ok: true,
            config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
            restartRequired: true,
            origins: ["https://box.tail1234.ts.net"],
            status: { state: "joined", addresses: ADDRESSES, hints: [] },
          })
        : url.pathname === "/api/admin/server"
          ? Response.json(view)
          : undefined,
    );
    await renderCard(
      row({ state: "published", published: true, status: { state: "published", addresses: ADDRESSES, hints: [] } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await screen.findByText("Asked to remove https://box.tail1234.ts.net from the trusted origins");
    // The notice stands alone: the route 409s this act, so a button opening a
    // dialog for it would be a lie with a spinner.
    expect(screen.getByText(/This server is not running under a service manager/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("locks the card's acts while the restart it started is still out", async () => {
    mockFetch((url) =>
      url.pathname === "/api/network/tailscale/unpublish"
        ? Response.json({
            ok: true,
            config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
            restartRequired: true,
            origins: ["https://box.tail1234.ts.net"],
            status: { state: "joined", addresses: ADDRESSES, hints: [] },
          })
        : url.pathname === "/api/admin/server/restart"
          ? Response.json({ restarting: true, resumeAt: "http://localhost:3080" })
          : url.pathname === "/api/admin/status"
            ? // Never answers: the outage is the state under test.
              new Promise<Response>(() => {})
            : undefined,
    );
    await renderCard(
      row({ state: "published", published: true, status: { state: "published", addresses: ADDRESSES, hints: [] } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await screen.findByText("Asked to remove https://box.tail1234.ts.net from the trusted origins");
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart server" }));

    // The spinner is the reason those buttons went quiet, and they went
    // quiet: an act started against a server that is coming back is an act
    // that fails offline.
    expect(await screen.findByText(/Restarting the server/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Unpublish" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refetches the networks and the public settings once the restart lands", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/api/network/tailscale/unpublish"
        ? Response.json({
            ok: true,
            config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
            restartRequired: true,
            origins: ["https://box.tail1234.ts.net"],
            status: { state: "joined", addresses: ADDRESSES, hints: [] },
          })
        : url.pathname === "/api/admin/server/restart"
          ? Response.json({ restarting: true, resumeAt: "http://localhost:3080" })
          : url.pathname === "/api/admin/status"
            ? Response.json({ runtime: { bootedAt: new Date().toISOString(), pid: 2, uptimeSeconds: 1 } })
            : undefined,
    );
    const client = await renderCard(
      row({ state: "published", published: true, status: { state: "published", addresses: ADDRESSES, hints: [] } }),
    );
    // A landed restart means the config the row's addresses are READ FROM has
    // changed — boot re-resolved everything. The card must tell the list and
    // the public settings so, itself; a reload should not be the user's job.
    // Spied on the client because no OBSERVER of either key is mounted in a
    // card test: the invalidation is the promise, the refetch is the page's.
    const invalidated: string[] = [];
    const invalidate = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
      if (filters?.queryKey) invalidated.push(JSON.stringify(filters.queryKey));
      return invalidate(filters as Parameters<typeof invalidate>[0]);
    }) as typeof client.invalidateQueries;

    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await screen.findByText("Asked to remove https://box.tail1234.ts.net from the trusted origins");
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart server" }));

    // `calls` is read back for the restart press itself; the waiter polled
    // `admin/status` on the fresh-boot answer above, so `back` lands.
    await waitFor(() => {
      expect(calls.some((c) => c.pathname === "/api/admin/status")).toBe(true);
    });
    await waitFor(() => {
      expect(invalidated).toContain(JSON.stringify(NETWORK_QUERY_KEY));
      expect(invalidated).toContain(JSON.stringify(PUBLIC_SETTINGS_QUERY_KEY));
    });
  });

  it("an implicit unpublish that stripped names the origins, and lands the row on joined", async () => {
    // After the § 5.3 reversal there is no `config: null` story for a
    // published implicit row — the record it clears IS its origins — so the
    // result reads exactly like the serve kind's, and the row that comes back
    // `joined` is the truth: still a member, no longer publishing.
    mockFetch((url) =>
      url.pathname === "/api/network/netbird/unpublish"
        ? Response.json({
            ok: true,
            config: { changed: ["TRUSTED_ORIGINS"], warnings: [], written: true },
            restartRequired: true,
            origins: ["http://nb.disaresta.internal"],
            status: { state: "joined", addresses: ADDRESSES, hints: [] },
          })
        : undefined,
    );
    await renderCard(
      row({
        id: "netbird",
        name: "NetBird",
        state: "published",
        published: true,
        publishImplicit: true,
        status: { state: "published", addresses: ADDRESSES, hints: [] },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    expect(
      await screen.findByText("Asked to remove http://nb.disaresta.internal from the trusted origins"),
    ).toBeTruthy();
    expect(screen.getByText("Restart the server to apply the change.")).toBeTruthy();
    expect(screen.queryByText(/Nothing was undone/)).toBeNull();
  });

  it("an unpublish that removed nothing says so plainly", async () => {
    mockFetch((url) =>
      url.pathname === "/api/network/netbird/unpublish"
        ? Response.json({
            ok: true,
            config: { changed: [], warnings: [], written: true },
            restartRequired: false,
            origins: ["http://nb.disaresta.internal"],
            status: { state: "joined", addresses: ADDRESSES, hints: [] },
          })
        : undefined,
    );
    await renderCard(
      row({
        id: "netbird",
        name: "NetBird",
        state: "published",
        published: true,
        publishImplicit: true,
        status: { state: "published", addresses: ADDRESSES, hints: [] },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    expect(await screen.findByText("Nothing was removed from the trusted origins.")).toBeTruthy();
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

  it("names the refused key instead of calling the whole file untouched", async () => {
    // `written: false` describes a KEY, not the file — the environment owning
    // `TRUSTED_ORIGINS` is what produces it now. Naming the key says WHERE the
    // change has to be made instead (the environment the server starts in),
    // which a flat "config.env was not changed" would hide.
    mockFetch((url) =>
      url.pathname === "/api/network/tailscale/publish"
        ? ndjson({
            type: "done",
            ok: true,
            addresses: ADDRESSES,
            config: {
              changed: [],
              warnings: [
                "TRUSTED_ORIGINS is set in the server's environment, so config.env cannot add these origins; add them where the server is started.",
              ],
              written: false,
              unwritableKey: "TRUSTED_ORIGINS",
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
    expect(line.textContent).toContain("TRUSTED_ORIGINS was not written to config.env");
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
    // …and the answer says what leaving DOES, machine-wide — `tailscale
    // logout` is not "this server goes quiet". With no stored credential on
    // this row it says nothing about deleting one.
    expect(
      within(dialog).getByText(
        "This machine leaves the Tailscale network, and the addresses this server answered on stop working.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Stored credentials/)).toBeNull();
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

  it("disconnect names the stored credential it is about to delete", async () => {
    // Every plugin's leave is machine-wide, and where a credential is stored
    // it goes with the rest — cloudflare's leave deletes the tunnel token.
    // Reconnecting then means pasting it again, which belongs before the
    // press rather than discovered at the next attempt.
    await renderCard(
      cloudflareRow({
        state: "joined",
        status: { state: "joined", addresses: ADDRESSES, hints: [] },
        settings: { "tunnel-token": { set: true } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "This machine leaves the Cloudflare Tunnel network, and the addresses this server answered on stop working. Stored credentials for this network are deleted; reconnecting means pasting them again.",
      ),
    ).toBeTruthy();
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
        status: {
          state: "joined",
          addresses: ADDRESSES,
          hints: [],
          identity: { network: "suteki.nu", hostname: "MacBook Pro", version: "1.102.4" },
        },
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
    // The FACTS stay: `compact` changes the frame, not the answer, and which
    // network this machine joined is the one thing the wizard step is about.
    expect(within(item).getByText("Network", { selector: "dt" })).toBeTruthy();
    expect(within(item).queryByText("Publish process", { selector: "dt" })).toBeNull();
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
