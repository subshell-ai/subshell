import { afterEach, describe, expect, it } from "bun:test";
import { SSH_ERROR_DESCRIPTIONS } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SshConnectionEditor } from "@/components/ssh/ssh-connection-editor";

/**
 * The connection editor's two load-bearing behaviors (SSH-SUPPORT.md §3):
 * a RESOLVED destination is previewed from the server's snapshot (names,
 * never raw config), and a NAMED refusal blocks the save - the Save button
 * can only ever carry a snapshot `/resolve` accepted. The stubbed answers
 * mirror the frozen `ssh-api-types.ts` shapes verbatim.
 */

/** One approved snapshot in the full frozen wire shape, forbidden members null. */
const SNAPSHOT = {
  alias: "staging",
  host: "app-02.example.net",
  user: "deploy",
  port: 22,
  identityFiles: ["/home/deploy/.ssh/id_ed25519"],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: ["/home/deploy/.ssh/known_hosts"],
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  forwards: null,
  tunnels: null,
  localCommands: null,
  remoteCommand: null,
  sendEnv: null,
  setEnv: null,
  escapes: null,
};

interface Call {
  path: string;
  method: string;
  body: unknown;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Routes every fetch to a canned answer and records the calls for assertions. */
function stubFetch(resolveView: unknown): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === "/api/nodes") {
      return json({ nodes: [{ id: "n1", name: "Laptop", canLaunch: true, status: "online", held: null }] });
    }
    if (url.pathname === "/api/ssh/discovery") {
      return json({ aliases: ["staging", "build-box"], includeCycle: false, truncated: false });
    }
    if (url.pathname === "/api/ssh/connections/resolve") return json(resolveView);
    if (url.pathname === "/api/ssh/connections" && method === "POST") {
      return json({ id: "c1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderEditor(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SshConnectionEditor open onOpenChange={() => {}} connection={null} />
    </QueryClientProvider>,
  );
}

/** Opens the node select and presses the one option, per the house Base UI recipe. */
async function pickNode(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox"));
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

async function resolveWith(alias: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Alias"), { target: { value: alias } });
  fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
}

describe("SshConnectionEditor", () => {
  let restore: () => void = () => {};
  afterEach(() => {
    restore();
    cleanup();
  });

  it("previews the resolved destination + connecting account and saves only the accepted snapshot", async () => {
    const stub = stubFetch({ accepted: true, snapshot: SNAPSHOT, connectingAccount: "deploy-lap" });
    restore = stub.restore;
    renderEditor();
    await pickNode("Laptop");
    await resolveWith("staging");

    // The review panel: destination (port 22 renders bare) + the §3 account line.
    await waitFor(() => expect(screen.getByText("deploy@app-02.example.net")).toBeDefined());
    expect(screen.getByText(/connecting account deploy-lap/)).toBeDefined();
    expect(screen.getByText(/Match exec/)).toBeDefined(); // the local-exec disclosure

    // A discovered alias chip is offered (names, no config contents).
    expect(screen.getByRole("button", { name: "build-box" })).toBeDefined();

    // Save is inert while the required name is empty, live once it is filled.
    const save = () => screen.getByRole("button", { name: "Save connection" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Staging" } });
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());

    await waitFor(() =>
      expect(stub.calls.some((c) => c.method === "POST" && c.path === "/api/ssh/connections")).toBe(true),
    );
    const created = stub.calls.find((c) => c.path === "/api/ssh/connections" && c.method === "POST")?.body as Record<
      string,
      unknown
    >;
    expect(created.displayName).toBe("Staging");
    expect(created.nodeId).toBe("n1");
    expect(created.snapshot).toEqual(SNAPSHOT);
    expect(created.remoteDir).toBeNull();
  });

  it("renders the named refusal's shipped sentence and blocks the save", async () => {
    const stub = stubFetch({ accepted: false, code: "unsupported_setting", settings: ["proxyCommand"] });
    restore = stub.restore;
    renderEditor();
    await pickNode("Laptop");
    await resolveWith("jumpy");

    await waitFor(() => expect(screen.getByText(SSH_ERROR_DESCRIPTIONS.unsupported_setting)).toBeDefined());
    expect(screen.getByText(/Blocked settings: proxyCommand/)).toBeDefined();

    // Even with the name filled, Save stays disabled: a refusal is not a snapshot.
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jumpy" } });
    const save = () => screen.getByRole("button", { name: "Save connection" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    // And the server never receives a create attempt.
    fireEvent.click(save());
    expect(stub.calls.some((c) => c.method === "POST" && c.path === "/api/ssh/connections")).toBe(false);
  });
});
