import { describe, expect, it } from "bun:test";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { ApiError } from "../api-client.js";
import type { IdentityKeyPair } from "../crypto.js";
import {
  cancelSshCommand,
  describeSshToolError,
  executeSshCommand,
  getTerminalExecution,
  listSshConnections,
  openSshTerminal,
  readSshCommand,
  type SshRunOutputView,
  type SshRunView,
  type SshTerminalExecView,
  type SshTerminalView,
} from "../ssh-tools.js";
import type { ToolApi } from "../tools.js";

/**
 * The SSH family is a thin passthrough over the frozen `/api/ssh` REST
 * shapes (SSH-SUPPORT.md §4), so these pin the wire (snake_case args in,
 * camelCase bodies out, the server's bounds untouched), the pass-through
 * honesty (255 / cancel-local-only / cursorExpired / unknown cross the MCP
 * layer unmodified), the refusal mapping (named `metadata.sshCode` matched
 * by equality, honest 404/403 framing), and the no-retry rule (a failed
 * call answers once; nothing resubmits).
 */

interface Recorded {
  path: string;
  method: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

/** A ToolApi that records every call and answers with `reply`. */
function api(calls: Recorded[], reply: (path: string) => unknown): ToolApi {
  return {
    async req<T>(
      path: string,
      init?: { method?: string; body?: unknown; query?: Record<string, unknown> },
    ): Promise<T> {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body, query: init?.query });
      return reply(path) as T;
    },
  };
}

/** An ApiError stub that fails EVERY call. The call count is the no-retry assertion. */
function failingApi(calls: Recorded[], err: unknown): ToolApi {
  return {
    async req<T>(path: string, init?: { method?: string }): Promise<T> {
      calls.push({ path, method: init?.method ?? "GET" });
      throw err;
    },
  };
}

// The stub shape server.test.ts uses: the SSH handlers touch no crypto.
const own: IdentityKeyPair = { principalId: "sess:test", publicJwk: "{}", privateJwk: "{}" };

/** A complete approved snapshot (every frozen member; the forbidden eight null). */
function snapshot(over: Partial<SshConnectionSnapshotWire> = {}): SshConnectionSnapshotWire {
  return {
    alias: "app02",
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
    ...over,
  };
}

/** A complete run view as the frozen `SshRunView` answers it. */
function runView(over: Partial<SshRunView> = {}): SshRunView {
  return {
    id: "run_1",
    connectionId: "conn-1",
    connectionRevision: 3,
    nodeId: "node-1",
    snapshot: snapshot(),
    initiatedBy: "agent",
    status: "accepted",
    cancelRequested: false,
    cancelLocalConfirmed: false,
    deadlineHit: false,
    deadlineMs: 300000,
    remoteStatus: null,
    remoteStatusConfirmed: false,
    localExitCode: null,
    localExitSignal: null,
    command: "uptime",
    remoteDir: null,
    createdAt: "2026-10-04T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

describe("list_ssh_connections (granted-only filtered read)", () => {
  it("hits the connections door ONCE and renders the display destination", async () => {
    const calls: Recorded[] = [];
    // The server's own answer: only granted rows (an ungranted same-owner
    // connection is simply absent). The MCP layer expands nothing.
    const out = await listSshConnections({
      api: api(calls, () => ({
        connections: [
          {
            id: "conn-1",
            nodeId: "node-1",
            displayName: "Staging",
            snapshot: snapshot(),
            remoteDir: "/srv/app",
            revision: 3,
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      })),
      own,
    });
    expect(calls).toEqual([{ path: "/api/ssh/connections", method: "GET", body: undefined, query: undefined }]);
    expect(out.connections).toHaveLength(1);
    const [row] = out.connections;
    expect(row?.destination).toBe("deploy@app-02.example.net:22");
    expect(row?.displayName).toBe("Staging");
  });

  it("renders the host without a user when the snapshot carries none", async () => {
    const calls: Recorded[] = [];
    const out = await listSshConnections({
      api: api(calls, () => ({
        connections: [
          {
            id: "c",
            nodeId: "n",
            displayName: "D",
            snapshot: snapshot({ user: null, host: "h.internal", port: 2222 }),
            remoteDir: null,
            revision: 1,
            createdAt: "x",
            updatedAt: "x",
          },
        ],
      })),
      own,
    });
    expect(out.connections[0]?.destination).toBe("h.internal:2222");
  });
});

describe("execute_ssh_command (start promptly, never retry)", () => {
  it("POSTs the camelCase body, omitting what the caller did not name", async () => {
    const calls: Recorded[] = [];
    const run = runView();
    const out = await executeSshCommand(
      { api: api(calls, () => run), own },
      { connection_id: "conn-1", command: "uptime" },
    );
    expect(calls[0]).toEqual({
      path: "/api/ssh/runs",
      method: "POST",
      body: { connectionId: "conn-1", command: "uptime" },
      query: undefined,
    });
    // The prompt `accepted` answer passes through verbatim (the frozen view).
    expect(out).toEqual(run);
  });

  it("maps remote_dir/deadline_ms to their camelCase REST names", async () => {
    const calls: Recorded[] = [];
    await executeSshCommand(
      { api: api(calls, () => runView()), own },
      { connection_id: "c", command: "ls", remote_dir: "/srv/app", deadline_ms: 60000 },
    );
    expect(calls[0]?.body).toEqual({
      connectionId: "c",
      command: "ls",
      remoteDir: "/srv/app",
      deadlineMs: 60000,
    });
  });

  it("does NOT retry a 5xx: one call, the honest failure surfaced", async () => {
    const calls: Recorded[] = [];
    const err = new ApiError(502, "the node link dropped before the answer", "UPSTREAM");
    await expect(
      executeSshCommand({ api: failingApi(calls, err), own }, { connection_id: "c", command: "x" }),
    ).rejects.toBe(err);
    expect(calls).toHaveLength(1);
    // A lost answer is framed as a lost answer, never as a green light to resend.
    expect(describeSshToolError(err).message).toContain("API error 502");
  });

  it("does NOT retry a named refusal", async () => {
    const calls: Recorded[] = [];
    const err = new ApiError(403, "Too many SSH commands are running for this quota right now.", "ACCESS_DENIED", {
      sshCode: "quota_runs",
    });
    await expect(
      executeSshCommand({ api: failingApi(calls, err), own }, { connection_id: "c", command: "x" }),
    ).rejects.toBe(err);
    expect(calls).toHaveLength(1);
  });
});

describe("read_ssh_command (bounded read; a wait is not a cancel)", () => {
  /** A timed-out wait: empty window, run STILL running, nothing cancelled. */
  const windowView: SshRunOutputView = {
    run: runView({ status: "running", startedAt: "2026-10-04T12:00:01.000Z" }),
    stdout: "",
    stderr: "",
    stdoutNext: 0,
    stderrNext: 0,
    stdoutTotal: 0,
    stderrTotal: 0,
    truncated: false,
    cursorExpired: false,
  };

  it("sends only the named window params, camelCase, on the output door", async () => {
    const calls: Recorded[] = [];
    const out = await readSshCommand(
      { api: api(calls, () => windowView), own },
      { run_id: "run 1", stdout_from_byte: 100, wait_ms: 5000 },
    );
    expect(calls[0]).toEqual({
      path: "/api/ssh/runs/run%201/output",
      method: "GET",
      body: undefined,
      query: { stdoutFromByte: 100, waitMs: 5000 },
    });
    expect(out).toEqual(windowView);
  });

  it("a timed-out wait reads ONCE: it never issues a cancel, and the run stays running", async () => {
    const calls: Recorded[] = [];
    const out = await readSshCommand({ api: api(calls, () => windowView), own }, { run_id: "run_1", wait_ms: 30000 });
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.path.includes("/cancel"))).toBe(false);
    expect(out.run.status).toBe("running");
  });

  it("passes the exit-255 ambiguity through UNMODIFIED: confirmed only when the server says so", async () => {
    const calls: Recorded[] = [];
    const ambivalent: SshRunOutputView = {
      ...windowView,
      run: runView({
        status: "completed",
        remoteStatus: 255,
        // The server's honesty: 255 alone never earns confirmed.
        remoteStatusConfirmed: false,
        localExitCode: 255,
        finishedAt: "2026-10-04T12:01:00.000Z",
      }),
      truncated: true,
      cursorExpired: true,
    };
    const out = await readSshCommand({ api: api(calls, () => ambivalent), own }, { run_id: "run_1" });
    expect(out.run.remoteStatus).toBe(255);
    expect(out.run.remoteStatusConfirmed).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.cursorExpired).toBe(true);
  });
});

describe("cancel_ssh_command (local confirmation only)", () => {
  it("POSTs the cancel door and passes the honest view through", async () => {
    const calls: Recorded[] = [];
    const cancelled = runView({
      status: "running",
      cancelRequested: true,
      cancelLocalConfirmed: true,
    });
    const out = await cancelSshCommand({ api: api(calls, () => cancelled), own }, { run_id: "run/1" });
    expect(calls[0]).toEqual({
      path: "/api/ssh/runs/run%2F1/cancel",
      method: "POST",
      body: undefined,
      query: undefined,
    });
    expect(out.cancelRequested).toBe(true);
    expect(out.cancelLocalConfirmed).toBe(true);
    // There is no remote-confirmed fact on the shape to over-claim: the
    // local flag is the whole answer the tool may carry.
    expect("cancelRemoteConfirmed" in out).toBe(false);
  });

  it("a bounded grace that confirmed NOTHING local says so verbatim", async () => {
    const calls: Recorded[] = [];
    const pending = runView({ cancelRequested: true, cancelLocalConfirmed: false });
    const out = await cancelSshCommand({ api: api(calls, () => pending), own }, { run_id: "run_1" });
    expect(out.cancelRequested).toBe(true);
    expect(out.cancelLocalConfirmed).toBe(false);
  });
});

describe("open_ssh_terminal", () => {
  it("POSTs the create door with only the named grid", async () => {
    const calls: Recorded[] = [];
    const pane: SshTerminalView = {
      subshellId: "pane-1",
      connectionId: "conn-1",
      connectionRevision: 3,
      initiatedBy: "agent",
      controlOwner: "agent",
      controlGeneration: 1,
      logGeneration: 1,
      createdAt: "2026-10-04T12:00:00.000Z",
    };
    const out = await openSshTerminal({ api: api(calls, () => pane), own }, { connection_id: "conn-1", cols: 120 });
    expect(calls[0]).toEqual({
      path: "/api/ssh/terminals",
      method: "POST",
      body: { connectionId: "conn-1", cols: 120 },
      query: undefined,
    });
    // An agent-opened pane starts in agent control; that fact is the server's
    // and rides untouched.
    expect(out.controlOwner).toBe("agent");
  });
});

describe("get_terminal_execution (read-only recovery)", () => {
  it("GETs the exec status door with both ids encoded and passes it through", async () => {
    const calls: Recorded[] = [];
    const rec: SshTerminalExecView = {
      id: "exec-1",
      subshellId: "pane-1",
      state: "outstanding",
      exitCode: null,
      output: null,
      outputTruncated: false,
      nextByte: 42,
      inputGeneration: 1,
      createdAt: "2026-10-04T12:00:00.000Z",
      resolvedAt: null,
    };
    const out = await getTerminalExecution(
      { api: api(calls, () => rec), own },
      { subshell_id: "pane/1", execution_id: "exec 1" },
    );
    expect(calls[0]).toEqual({
      path: "/api/subshells/pane%2F1/execs/exec%201",
      method: "GET",
      body: undefined,
      query: undefined,
    });
    expect(out).toEqual(rec);
  });

  it("an `unknown` record arrives as unknown (one read, no re-exec)", async () => {
    const calls: Recorded[] = [];
    const lost: SshTerminalExecView = {
      id: "e",
      subshellId: "p",
      state: "unknown",
      exitCode: null,
      output: "partial",
      outputTruncated: true,
      nextByte: 9,
      inputGeneration: 2,
      createdAt: "x",
      resolvedAt: null,
    };
    const out = await getTerminalExecution(
      { api: api(calls, () => lost), own },
      { subshell_id: "p", execution_id: "e" },
    );
    expect(calls).toHaveLength(1);
    expect(out.state).toBe("unknown");
  });
});

describe("describeSshToolError (honest refusal mapping)", () => {
  it("names a policy refusal by its equality-matched code", () => {
    const err = new ApiError(403, "This connection is not granted to this pane.", "ACCESS_DENIED", {
      sshCode: "not_granted",
    });
    expect(describeSshToolError(err).message).toContain("ssh refusal (not_granted)");
    expect(describeSshToolError(err).message).toContain("not granted to this pane");
  });

  it("names a protocol refusal (token_stale, node_ineligible, quota_run family, run_unknown)", () => {
    for (const code of ["token_stale", "node_ineligible", "storage_full", "run_unknown", "host_key_unknown"] as const) {
      const err = new ApiError(code === "run_unknown" || code === "storage_full" ? 409 : 403, "server sentence", "X", {
        sshCode: code,
      });
      expect(describeSshToolError(err).message).toContain(`ssh refusal (${code})`);
    }
  });

  it("frames ANY 404 as SSH-invisible without claiming what it was (no-enumeration honesty)", () => {
    const bare = new ApiError(404, "Not found.", "NOT_FOUND_ERROR");
    const msg = describeSshToolError(bare).message;
    expect(msg).toContain("not visible to this pane");
    expect(msg).toContain("list_ssh_connections");
    expect(msg).not.toContain("list_subshells");
    const named = new ApiError(404, "Not found.", "NOT_FOUND_ERROR", { sshCode: "not_found" });
    expect(describeSshToolError(named).message).toContain("not visible to this pane");
  });

  it("a bare 403 (the coarse ssh scope) names the scope + grant remedy", () => {
    const msg = describeSshToolError(new ApiError(403, "Forbidden")).message;
    expect(msg).toContain("ssh refused for this pane");
    expect(msg).toContain("ssh scope");
    expect(msg).toContain("never restart your own pane");
  });

  it("an unknown metadata code falls through to the shared map (nothing invented)", () => {
    // 409 carries no SSH-specific branch of its own: every named SSH 409
    // arrives through the code branch, so an unrecognized code must answer
    // EXACTLY what describeToolError says, with no SSH framing added.
    const err = new ApiError(409, "Some conflict", "EXISTS_ERROR", { sshCode: "from_a_future_build" });
    expect(describeSshToolError(err).message).toBe(
      "subshell: conflict: Some conflict; list_nodes and list_presets answer what is available",
    );
    // A named code still wins wherever it lands (409 quota, no status guess needed).
    const named = new ApiError(409, "The node's SSH output store is full.", "EXISTS_ERROR", {
      sshCode: "storage_full",
    });
    expect(describeSshToolError(named).message).toContain("ssh refusal (storage_full)");
  });

  it("the 401 token death keeps its shared sentence (it is not an SSH fact)", () => {
    const msg = describeSshToolError(new ApiError(401, "Unauthorized")).message;
    expect(msg).toContain("ask a human to restart this subshell");
  });

  it("non-ApiError values pass through unchanged", () => {
    const boom = new Error("boom");
    expect(describeSshToolError(boom)).toBe(boom);
  });
});
