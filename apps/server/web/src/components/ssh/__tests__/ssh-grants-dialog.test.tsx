import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SshGrantsDialog } from "@/components/ssh/ssh-grants-dialog";
import type { SshConnectionView } from "@/lib/ssh";

/**
 * Grant management talks to the frozen grant endpoints and nothing else:
 * the ON toggle is `POST /api/ssh/connections/:id/grants` with the body
 * `{subshellId}`, the OFF toggle is
 * `DELETE /api/ssh/connections/:id/grants/:subshellId`. The offered list is
 * the OWNER's RUNNING panes only (a grant binds a pane and its current key;
 * a shared-in row or a dead row has nothing to bind), and revoked history
 * renders from the same read.
 */

const CONNECTION: SshConnectionView = {
  id: "c1",
  nodeId: "n1",
  displayName: "Staging",
  snapshot: {
    alias: "staging",
    host: "app-02.example.net",
    user: "deploy",
    port: 22,
    identityFiles: [],
    certificateFiles: [],
    authAgentSocket: null,
    knownHostsFiles: [],
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
  },
  remoteDir: null,
  revision: 1,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
};

const PANE = (id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  presetId: null,
  harnessId: "claude",
  nodeId: "n1",
  nodeOffline: false,
  name,
  nameLocked: false,
  workingDir: "/srv/app",
  status: "running",
  createdAt: "2026-10-01T10:00:00.000Z",
  endedAt: null,
  lastOutputAt: null,
  activity: "idle",
  alive: true,
  exitCode: null,
  startedAt: null,
  backoffCount: 0,
  restartOnExit: false,
  nextRestartAt: null,
  notify: true,
  waitingSince: null,
  unseenPush: false,
  access: "owner",
  ...over,
});

interface Call {
  path: string;
  method: string;
  body: unknown;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function stubFetch(calls: Call[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === "/api/ssh/connections/c1/grants" && method === "GET") {
      return json({
        grants: [
          {
            id: "g1",
            connectionId: "c1",
            connectionRevision: 1,
            subshellId: "p1",
            apiKeyId: "key-1",
            grantedByUserId: "u1",
            grantedAt: "2026-10-02T09:00:00.000Z",
            revokedAt: null,
            active: true,
          },
          {
            id: "g0",
            connectionId: "c1",
            connectionRevision: 1,
            subshellId: "p-old",
            apiKeyId: "key-0",
            grantedByUserId: "u1",
            grantedAt: "2026-10-01T09:00:00.000Z",
            revokedAt: "2026-10-01T12:00:00.000Z",
            active: false,
          },
        ],
      });
    }
    if (url.pathname === "/api/ssh/connections/c1/grants" && method === "POST") return json({ ok: true });
    if (url.pathname === "/api/ssh/connections/c1/grants/p1" && method === "DELETE") return json({ revoked: true });
    if (url.pathname === "/api/subshells") {
      return json([
        PANE("p1", "helper-bot"),
        PANE("p2", "worker-two"),
        PANE("p-shared", "not-yours", { access: "edit" }),
        PANE("p-dead", "ended-one", { status: "terminated", alive: false }),
      ]);
    }
    if (url.pathname === "/api/users") {
      return json({ viewerIsAdmin: false, users: [{ id: "u1", name: "Theo", email: "theo@example.com" }] });
    }
    throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

function renderDialog(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SshGrantsDialog open onOpenChange={() => {}} connection={CONNECTION} />
    </QueryClientProvider>,
  );
}

describe("SshGrantsDialog", () => {
  let calls: Call[] = [];
  let restore: () => void = () => {};
  afterEach(() => {
    restore();
    cleanup();
  });

  it("lists the owner's running panes with the live grant switched on", async () => {
    calls = [];
    restore = stubFetch(calls);
    renderDialog();
    await waitFor(() => expect(screen.getByText("helper-bot")).toBeDefined());
    expect(screen.getByText("worker-two")).toBeDefined();
    // Shared-in and terminated rows are not grantable and never render as switches.
    expect(screen.queryByText("not-yours")).toBeNull();
    expect(screen.queryByText("ended-one")).toBeNull();
    // The revoked history row is visible.
    expect(screen.getByText(/Revoked history/)).toBeDefined();

    const switches = () => screen.getAllByRole("switch");
    const helper = screen.getByRole("switch", { name: "Revoke SSH access for helper-bot" });
    expect(switches().length).toBe(2);
    expect(helper.getAttribute("aria-checked")).toBe("true");
    const worker = screen.getByRole("switch", { name: "Grant SSH access to worker-two" });
    expect(worker.getAttribute("aria-checked")).toBe("false");
  });

  it("grants with POST + {subshellId} and revokes with DELETE on the pane path", async () => {
    calls = [];
    restore = stubFetch(calls);
    renderDialog();
    await waitFor(() => expect(screen.getByText("worker-two")).toBeDefined());

    fireEvent.click(screen.getByRole("switch", { name: "Grant SSH access to worker-two" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/ssh/connections/c1/grants")).toBe(true),
    );
    const grantCall = calls.find((c) => c.method === "POST" && c.path === "/api/ssh/connections/c1/grants");
    expect(grantCall?.body).toEqual({ subshellId: "p2" });

    fireEvent.click(screen.getByRole("switch", { name: "Revoke SSH access for helper-bot" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/ssh/connections/c1/grants/p1")).toBe(true),
    );
  });
});
