import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NODE_PROTOCOL_VERSION, SSH_RUNTIME_PROTOCOL } from "@internal/subshell-protocol";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { missingSshBins, type SshFixture, startSshFixture } from "../fixtures/sshd";
import { shortTmuxBase } from "../stack";
import { NODE_MAIN, type RunningNode, startNode } from "../stub/client";
import { pollUntil, sleep, sweepTmuxServers } from "./helpers";
import { type NodeRow, rmScratch, seedAdminApi } from "./ssh-support";

/**
 * SSH RUNTIME SESSIONS end to end (design 2026-10-05 §9, Gate A): the whole
 * chain with no fake - plane, real enrolled agent, policy-rendered ssh child,
 * the repo's OWN `runtime-serve` running on the destination over a fixture
 * sshd, a real terminal pane on the destination's tmux, typed bytes returning
 * through the framed channel, one REST callback executed by the plane as the
 * pane's own token, an ordinary REST terminate that kills the DESTINATION pane
 * while the session survives, and a close that kills BOTH halves of the
 * channel (the process-kill proof the review asked for: a leaked ssh child
 * occupies the per-node quota forever). The negatives ride along: a foreign
 * callback path is refused, the runtime binds no TCP listener, an absent
 * destination runtime refuses by name, the ssh child dying under a live link
 * marks the session LOST with the node still online, and losing the whole
 * agent marks it LOST too (the pane unavailable, not completed).
 *
 * The destination IS this host (the fixture sshd dials loopback as the same
 * account), so `runtimeCommand` is a wrapper that re-enters this checkout:
 * `bun <repo>/apps/node/agent/src/main.ts runtime-serve ...` - the source-mode
 * parity spec 12 established, one layer across an SSH hop. The wrapper pins
 * the destination-side runtime data dir and TMUX_TMPDIR into scratch dirs the
 * teardown owns. Terminal truth is REST/log truth (AGENTS.md: never xterm).
 */

const missing = missingSshBins();
test.skip(missing.length > 0, `real-ssh runtime e2e skipped: this host lacks ${missing.join(", ")}`);
// API-driven (the spec's proof is the chain, not chrome): the admin context
// comes from seedAdminApi, which also covers a focused run without spec 01.
test.describe.configure({ mode: "serial" });

const RUN = Math.random().toString(36).slice(2, 7);
const NODE_NAME = `e2e-rt-${RUN}`;

/** The wrapper the destination runs instead of an installed `subshell`. */
function resolveBun(): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "")) {
    try {
      accessSync(path.join(dir, "bun"));
      return path.join(dir, "bun");
    } catch {
      // not here
    }
  }
  throw new Error("the e2e host has no bun on PATH (spec 12/21 would already have died)");
}

let fixture: SshFixture | undefined;
let agent: RunningNode | undefined;
let agentHome = "";
let tmuxBase = "";
let destTmuxBase = "";
let fixtureRoot = "";
let scratch = "";
let wrapperPath = "";
let nodeId = "";
let setupKey = "";
let setupKeyId = "";
let api: APIRequestContext;

const ssh = (): SshFixture => {
  if (fixture === undefined) throw new Error("the sshd fixture never started");
  return fixture;
};
const agentTail = (): string => agent?.logTail() ?? "(agent never started)";

/** The ordered chain's sessions (each test names the one it owns). */
let sessionId = "";
let paneId = "";

/** The runtime's process liveness for one session ref. The `runtime-serve
 * --session <ref>` argv is carried by BOTH halves of the channel - the
 * connecting node's ssh child (the remote command line sits in its argv) and
 * the destination's `runtime-serve` - so zero means neither survives, which
 * is exactly the close promise. */
function runtimePids(sessionRef: string): string[] {
  const find = spawnSync("pgrep", ["-f", `runtime-serve --session ${sessionRef}`], { encoding: "utf8" });
  return find.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** The CONNECTING side's ssh child for one session: its argv carries the
 * rendered config path, which is named by the ref and by nothing else. */
function sshChildPid(sessionRef: string): string {
  const find = spawnSync("pgrep", ["-f", `${sessionRef}.config`], { encoding: "utf8" });
  const pids = find.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  expect(pids.length, `the ssh child for ${sessionRef.slice(0, 8)} should be live`).toBeGreaterThanOrEqual(1);
  return pids[0] as string;
}

/** The destination's tmux session names, read as the test host (the destination IS this machine, socket in the wrapper's TMUX_TMPDIR). */
function destTmuxSessions(socket: string): string[] {
  const r = spawnSync("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
    encoding: "utf8",
    env: { ...process.env, TMUX_TMPDIR: destTmuxBase },
  });
  if (r.error !== undefined) throw new Error(`tmux(1) unavailable: ${r.error.message}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

interface SessionView {
  id: string;
  runtimeNodeId: string;
  status: string;
  hello: {
    runtimeProtocol: number;
    dataDir: string;
    tmuxSocket: string;
    paneCount: number;
    capabilities: string[];
  } | null;
}

async function openRuntimeSession(
  runtimeCommand: string,
): Promise<{ res: Awaited<ReturnType<APIRequestContext["post"]>> }> {
  const f = ssh();
  const res = await api.post("/api/ssh-runtime/sessions", {
    data: {
      connectingNodeId: nodeId,
      target: { alias: "e2edest", host: "127.0.0.1", port: f.port, user: f.user, identityFile: f.trustedKeyPath },
      runtimeCommand,
    },
  });
  return { res };
}

const logText = async (id: string): Promise<string> => {
  const res = await api.get(`/api/subshells/${id}/log`);
  if (!res.ok()) return "";
  return ((await res.json()) as { lines: string[] }).lines.join("\n");
};

test.beforeAll(async () => {
  api = await seedAdminApi();

  fixtureRoot = mkdtempSync(path.join(tmpdir(), "subshell-e2e-rt-sshd-"));
  fixture = await startSshFixture(fixtureRoot);

  scratch = mkdtempSync(path.join(tmpdir(), "subshell-e2e-rt-"));
  const runtimeData = path.join(scratch, "runtime-data");
  destTmuxBase = path.join(scratch, "tmux-dest");
  mkdirSync(runtimeData, { recursive: true, mode: 0o700 });
  mkdirSync(destTmuxBase, { recursive: true, mode: 0o700 });
  wrapperPath = path.join(scratch, "runtime-wrapper.sh");
  writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      `export SUBSHELL_RUNTIME_DATA_DIR=${runtimeData}`,
      `export TMUX_TMPDIR=${destTmuxBase}`,
      `exec ${resolveBun()} ${NODE_MAIN} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(wrapperPath, 0o755);

  const mint = await api.post("/api/nodes/setup-keys");
  expect(mint.ok(), await mint.text()).toBe(true);
  const key = (await mint.json()) as { id: string; key: string };
  setupKeyId = key.id;
  setupKey = key.key;

  agentHome = mkdtempSync(path.join(tmpdir(), "subshell-e2e-rt-node-"));
  tmuxBase = shortTmuxBase(); // the CONNECTING side's tmux home (spec 21's sun_path rule)
  agent = await startNode({
    home: agentHome,
    dataDir: path.join(agentHome, "data"),
    tmuxBase,
    setupKey,
    name: NODE_NAME,
    extraEnv: { HOME: fixture.sshConfigHome, USER: fixture.user, LOGNAME: fixture.user, SSH_AUTH_SOCK: "" },
  });

  await pollUntil(
    `node "${NODE_NAME}" never came online`,
    async () => {
      const res = await api.get("/api/nodes");
      expect(res.ok(), await res.text()).toBe(true);
      const row = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.name === NODE_NAME);
      if (row) nodeId = row.id;
      return row?.status === "online";
    },
    { tail: agentTail },
  );
});

test.afterAll(async () => {
  const leaks: string[] = [];
  try {
    await agent?.stop();
  } catch (err) {
    leaks.push(`agent stop: ${String(err)}`);
  }
  sweepTmuxServers(tmuxBase);
  sweepTmuxServers(destTmuxBase); // the DESTINATION's servers live under the wrapper's TMUX_TMPDIR
  try {
    await fixture?.stop();
  } catch (err) {
    leaks.push(`sshd stop: ${String(err)}`);
  }
  if (api !== undefined) {
    if (sessionId) {
      // best-effort close of whatever session survived the run (a settled one answers 404/409, fine)
      await api.post(`/api/ssh-runtime/sessions/${sessionId}/close`).catch(() => undefined);
    }
    if (nodeId) {
      for (let i = 0; i < 10; i++) {
        try {
          const del = await api.delete(`/api/nodes/${nodeId}?force=true`);
          if (del.ok() || del.status() === 404) break;
          if (i === 9) leaks.push(`node delete: HTTP ${del.status()}`);
        } catch (err) {
          leaks.push(`node delete: ${String(err)}`);
          break;
        }
        await sleep(500);
      }
    }
    if (setupKeyId) {
      const rev = await api.delete(`/api/nodes/setup-keys/${setupKeyId}`);
      if (!rev.ok() && rev.status() !== 404) leaks.push(`setup-key revoke: HTTP ${rev.status()}`);
    }
    await api.dispose();
  }
  rmScratch(agentHome);
  rmScratch(fixtureRoot);
  rmScratch(scratch);
  rmScratch(path.dirname(tmuxBase));
  if (leaks.length > 0) console.error(`[22-ssh-runtime] cleanup problems: ${leaks.join("; ")}`);
});

test("open: probe, spawn, framed hello; the view carries destination truth", async () => {
  test.setTimeout(180_000);
  const { res } = await openRuntimeSession(wrapperPath);
  expect(res.ok(), await res.text()).toBe(true);
  const view = (await res.json()) as SessionView;
  sessionId = view.id;
  expect(view.status).toBe("active");
  expect(view.hello?.runtimeProtocol).toBe(SSH_RUNTIME_PROTOCOL);
  // The hello's dataDir is the WRAPPER's env, not the connecting side's: the
  // runtime really ran on the destination with its own namespace.
  expect(view.hello?.dataDir).toBe(path.join(scratch, "runtime-data"));
  expect(view.hello?.tmuxSocket).toMatch(/^subshell-ssh-[0-9a-f]{12}$/);
  expect(view.hello?.paneCount, "a fresh socket on a fresh fixture account has no panes yet").toBe(0);
  expect(view.hello?.capabilities.length).toBeGreaterThan(0);

  // The hidden runtime node row is NEVER listed: the session references it,
  // the nodes surface must not show it (design §4's concealment).
  const nodes = await api.get("/api/nodes");
  const listed = ((await nodes.json()) as { nodes: NodeRow[] }).nodes;
  expect(
    listed.some((n) => n.id === view.runtimeNodeId),
    "runtime rows stay out of listings",
  ).toBe(false);

  const get = await api.get(`/api/ssh-runtime/sessions/${sessionId}`);
  expect(get.ok(), await get.text()).toBe(true);
  expect(((await get.json()) as SessionView).status).toBe("active");
});

test("pane lifecycle: terminal launch, a typed marker returns through the framed log read", async () => {
  test.setTimeout(120_000);
  const launch = await api.post(`/api/ssh-runtime/sessions/${sessionId}/launch-terminal`, {
    data: { cwd: fixtureRoot, cols: 80, rows: 24 },
  });
  expect(launch.ok(), await launch.text()).toBe(true);
  paneId = ((await launch.json()) as { subshellId: string }).subshellId;

  // The pane is an ordinary subshell row: list, detail and log all read it.
  const row = await api.get(`/api/subshells/${paneId}`);
  expect(row.ok(), await row.text()).toBe(true);
  const pane = (await row.json()) as { status: string; alive: boolean };
  expect(pane.status).toBe("running");
  expect(pane.alive).toBe(true);

  const typed = `echo RT-MARKER-${RUN}`;
  const input = await api.post(`/api/subshells/${paneId}/input`, { data: { text: typed, submit: true } });
  expect(input.ok(), await input.text()).toBe(true);

  // TWO occurrences are the proof, and they prove different halves: the echo
  // of the typed line means the INPUT frame reached the pane; the marker
  // standing ALONE (not glued to `echo`) means the pane RAN the command and
  // its output came back through GET /log -> log_read frames. Counting beats
  // line equality here: the destination's interactive shell redraws with
  // control residue that survives ANSI stripping as non-whitespace bytes.
  await pollUntil(
    "the typed marker never appeared (echoed AND run) in the destination pane's log tail",
    async () => {
      const text = await logText(paneId);
      const hits = text.split(`RT-MARKER-${RUN}`).length - 1;
      return hits >= 2 && text.includes(typed);
    },
    { budgetMs: 60_000, tail: agentTail },
  );
});

test("callback: the pane's curl through callback.sock executes as its own token; a foreign path is refused", async () => {
  test.setTimeout(120_000);
  if (spawnSync("curl", ["--version"]).error !== undefined) test.skip(true, "no curl(1) on this host");
  // The pane's own curl over the UNIX socket (design §5): the runtime forwards
  // the request to the plane, which executes it with the pane's own bearer and
  // relays the answer back. The response goes to a FILE the test reads (not
  // the terminal stream): the destination shell's redraw is its own business,
  // and the bytes proving the round trip deserve a deterministic read.
  const cbDir = path.join(scratch, "cb");
  mkdirSync(cbDir, { recursive: true, mode: 0o700 });
  const ownBody = path.join(cbDir, "own.json");
  const foreignBody = path.join(cbDir, "foreign.json");

  const read = (p: string): string => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };

  const own = await api.post(`/api/subshells/${paneId}/input`, {
    data: {
      text: `curl -s --unix-socket "$SUBSHELL_RUNTIME_CALLBACK_SOCK" -o ${ownBody} http://unix/api/subshells/$SUBSHELL_ID`,
      submit: true,
    },
  });
  expect(own.ok(), await own.text()).toBe(true);
  await pollUntil(
    "the callback response never reached the destination file",
    async () => read(ownBody).includes('"workingDir"'),
    { budgetMs: 60_000, tail: agentTail },
  );

  // Foreign path: the allowlist refuses it without ever fetching - the pane
  // sees the named 403 body, and NOTHING executed as its token.
  const foreign = await api.post(`/api/subshells/${paneId}/input`, {
    data: {
      text: `curl -s --unix-socket "$SUBSHELL_RUNTIME_CALLBACK_SOCK" -o ${foreignBody} http://unix/api/users`,
      submit: true,
    },
  });
  expect(foreign.ok(), await foreign.text()).toBe(true);
  await pollUntil(
    "the refused callback never answered forbidden",
    async () => read(foreignBody).includes("forbidden"),
    { budgetMs: 60_000, tail: agentTail },
  );
});

test("containment: the runtime-serve on the destination holds no TCP listener", async () => {
  test.setTimeout(60_000);
  // `runtimePids` names both halves that carry the session ref in argv (the
  // connecting side's ssh child and the destination runtime); the listener
  // question is answered against the UNION, which is the stronger check.
  const pids = runtimePids(sessionId);
  expect(pids.length, "the runtime-serve child is live on the destination").toBeGreaterThan(0);

  const ss = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
  if (ss.error !== undefined) test.skip(true, "no ss(8) on this host");
  expect(ss.stdout, "no LISTEN socket belongs to the runtime pid (it serves stdio + the unix socket only)").not.toMatch(
    new RegExp(`pid=(${pids.join("|")})[,)]`),
  );
});

test("absent runtime: the probe refuses by name before any child is kept", async () => {
  test.setTimeout(60_000);
  const { res } = await openRuntimeSession("/nonexistent/subshell-xyz");
  // 403 with the named code riding the body: the house SSH-refusal convention
  // (a destination's answer is ACCESS_DENIED, quota/conflict facts are 409),
  // and the e2e precedent asserts the code's presence, not the status alone.
  expect(res.status(), await res.text()).toBe(403);
  const text = await res.text();
  expect(text).toContain("runtime_missing");

  // The refused open left no history behind that could be mistaken for a session.
  const list = await api.get("/api/ssh-runtime/sessions");
  expect(list.ok(), await list.text()).toBe(true);
  const sessions = ((await list.json()) as { sessions: SessionView[] }).sessions;
  expect(sessions.filter((s) => s.status === "opening").length).toBe(0);
});

test("close: settles, the census arrives, BOTH halves of the channel die, the pane's tmux survives", async () => {
  test.setTimeout(120_000);
  const closedSessionRef = sessionId;
  const close = await api.post(`/api/ssh-runtime/sessions/${sessionId}/close`);
  expect(close.ok(), await close.text()).toBe(true);
  await pollUntil(
    "the closed session never settled",
    async () => {
      const res = await api.get(`/api/ssh-runtime/sessions/${sessionId}`);
      if (!res.ok()) return false;
      return ((await res.json()) as SessionView).status === "closed";
    },
    { budgetMs: 30_000, tail: agentTail },
  );

  // The C1 proof, end to end: a graceful close must kill BOTH the destination
  // `runtime-serve` (the close frame reached it) AND the connecting node's ssh
  // child (the broker's group-kill reached it). Before the fix the close frame
  // was never sent and both leaked until the agent restarted.
  await pollUntil(
    "the closed session's runtime/ssh processes never went away",
    async () => runtimePids(closedSessionRef).length === 0,
    { budgetMs: 20_000, tail: agentTail },
  );

  // The pane SURVIVED on the destination's tmux (design §6 Close: panes keep
  // running) while the plane's row reads the unavailable truth: running, alive
  // false - the census told the plane what was alive, and a live pane with a
  // dead session is exactly that reading (review NIT: pinned, not commented).
  const row = await api.get(`/api/subshells/${paneId}`);
  expect(row.ok(), await row.text()).toBe(true);
  const pane = (await row.json()) as { status: string; alive: boolean };
  expect(pane.status).toBe("running");
  expect(pane.alive, "the plane's row says unavailable after a graceful close").toBe(false);

  // Reconciliation: the deterministic per-destination socket still holds the
  // pane, so the NEW session's hello counts it.
  const { res } = await openRuntimeSession(wrapperPath);
  expect(res.ok(), await res.text()).toBe(true);
  const second = (await res.json()) as SessionView;
  expect(second.hello?.paneCount, "the second session finds the first session's pane").toBeGreaterThanOrEqual(1);
  // Direct proof the destination's tmux kept the pane: its session name (the
  // launch's `subshellName` = the pane id) is still listed on the socket.
  expect(destTmuxSessions(second.hello?.tmuxSocket ?? "unset")).toContain(paneId);
  sessionId = second.id; // the following tests drive the surviving session
});

test("terminate: an ordinary REST terminate reaches the pane through the frame and kills it on the destination", async () => {
  test.setTimeout(120_000);
  const launch = await api.post(`/api/ssh-runtime/sessions/${sessionId}/launch-terminal`, {
    data: { cwd: fixtureRoot, cols: 80, rows: 24 },
  });
  expect(launch.ok(), await launch.text()).toBe(true);
  const pane2 = ((await launch.json()) as { subshellId: string }).subshellId;
  // A live pane first (the marker echo proves the pane ran): input it.
  await api.post(`/api/subshells/${pane2}/input`, { data: { text: "true", submit: true } });
  await pollUntil(
    "the terminated-session pane never appeared on the destination socket",
    async () => destTmuxSessions((await sessionSocket()).tmuxSocket).includes(pane2),
    { budgetMs: 60_000, tail: agentTail },
  );

  const term = await api.post(`/api/subshells/${pane2}/terminate`);
  expect(term.ok(), await term.text()).toBe(true);
  // The row reflects it (the ordinary pane plumbing, unchanged).
  await pollUntil(
    "the terminated runtime pane's row never settled",
    async () => {
      const res = await api.get(`/api/subshells/${pane2}`);
      if (!res.ok()) return false;
      const row = (await res.json()) as { alive: boolean };
      return row.alive === false;
      // (status rides the terminate path's own word; alive is the shared truth)
    },
    { budgetMs: 30_000, tail: agentTail },
  );
  // The DESTINATION pane is gone: the terminate frame reached the runtime and
  // killed exactly one pane - and the session survives (design §6: killing
  // panes is terminate's job, and a terminate must not read as a session loss).
  const socket = (await sessionSocket()).tmuxSocket;
  expect(destTmuxSessions(socket), "the terminated pane left the destination tmux").not.toContain(pane2);
  const still = await api.get(`/api/ssh-runtime/sessions/${sessionId}`);
  expect(still.ok(), await still.text()).toBe(true);
  expect(((await still.json()) as SessionView).status).toBe("active");
});

/** The live session's destination facts (socket) via the session view. */
async function sessionSocket(): Promise<{ tmuxSocket: string }> {
  const res = await api.get(`/api/ssh-runtime/sessions/${sessionId}`);
  expect(res.ok(), await res.text()).toBe(true);
  const view = (await res.json()) as SessionView;
  if (view.hello === null) throw new Error("session has no hello (not active?)");
  return view.hello;
}

test("child dies with the link ALIVE: the ssh child's death marks the session lost and the node stays online", async () => {
  test.setTimeout(120_000);
  // The arm the disconnect test cannot exercise (it kills the whole agent):
  // one child death, reported through the live link (`ssh_session_lost` ->
  // `deliverSessionLost`), with everything else still standing.
  const launch = await api.post(`/api/ssh-runtime/sessions/${sessionId}/launch-terminal`, {
    data: { cwd: fixtureRoot },
  });
  expect(launch.ok(), await launch.text()).toBe(true);
  const pane3 = ((await launch.json()) as { subshellId: string }).subshellId;

  const child = sshChildPid(sessionId);
  process.kill(Number(child), "SIGTERM");

  await pollUntil(
    "the session never read lost after its ssh child died",
    async () => {
      const res = await api.get(`/api/ssh-runtime/sessions/${sessionId}`);
      if (!res.ok()) return false;
      return ((await res.json()) as SessionView).status === "lost";
    },
    { budgetMs: 30_000, tail: agentTail },
  );

  // The pane reads the design §6 truth for a lost channel: alive false,
  // status intact - unavailable, not completed (the child died; nobody
  // watched the pane end).
  const pane3Row = await api.get(`/api/subshells/${pane3}`);
  expect(pane3Row.ok(), await pane3Row.text()).toBe(true);
  const p3 = (await pane3Row.json()) as { status: string; alive: boolean };
  expect(p3.alive).toBe(false);
  expect(p3.status).toBe("running");

  // The link is untouched: the agent is still online (the child died, not the
  // daemon) - the distinction the whole broker design rests on.
  const nodes = await api.get("/api/nodes");
  const row = ((await nodes.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.id === nodeId);
  expect(row?.status, "losing one session child must not take the connecting node offline").toBe("online");

  // Open the session the FINAL test consumes (the disconnect test needs a
  // live session, and this one is now history).
  const { res } = await openRuntimeSession(wrapperPath);
  expect(res.ok(), await res.text()).toBe(true);
  sessionId = ((await res.json()) as SessionView).id;
});

test("protocol 17 reality: the node registered on the exact-match handshake", async () => {
  const res = await api.get("/api/nodes");
  expect(res.ok(), await res.text()).toBe(true);
  const row = ((await res.json()) as { nodes: NodeRow[] }).nodes.find((n) => n.id === nodeId);
  // The session verbs ride protocol 17 exactly (no fallback): the online row
  // at NODE_PROTOCOL_VERSION IS the registration, and every test above is its
  // functional half against the real daemon.
  expect(row?.status).toBe("online");
  expect(row?.protocolVersion).toBe(NODE_PROTOCOL_VERSION);
});

test("disconnect: losing the link marks the session LOST and the pane unavailable, not completed", async () => {
  test.setTimeout(120_000);
  // A pane on the session THIS test kills (review M-A: the old assertion read
  // the first session's pane, settled alive:false tests ago, so it proved
  // nothing about the disconnect settling).
  const launch = await api.post(`/api/ssh-runtime/sessions/${sessionId}/launch-terminal`, {
    data: { cwd: fixtureRoot },
  });
  expect(launch.ok(), await launch.text()).toBe(true);
  const disconnectPaneId = ((await launch.json()) as { subshellId: string }).subshellId;
  const beforeRow = await api.get(`/api/subshells/${disconnectPaneId}`);
  expect(beforeRow.ok(), await beforeRow.text()).toBe(true);
  expect(((await beforeRow.json()) as { alive: boolean }).alive, "the pane is live before the kill").toBe(true);

  await agent?.stop();
  await pollUntil(
    "the session never read lost after the connecting node died",
    async () => {
      const res = await api.get(`/api/ssh-runtime/sessions/${sessionId}`);
      if (!res.ok()) return false;
      return ((await res.json()) as SessionView).status === "lost";
    },
    { budgetMs: 30_000 },
  );
  // The honest pane state for THIS pane: unavailable (alive false) while its
  // status stays what it last was (design §6: lost, not completed). Polled,
  // not immediate: the lost settling writes the session row before it walks
  // the pane rows.
  await pollUntil(
    "the disconnected session's pane never went unavailable",
    async () => {
      const res = await api.get(`/api/subshells/${disconnectPaneId}`);
      if (!res.ok()) return false;
      return ((await res.json()) as { alive: boolean }).alive === false;
    },
    { budgetMs: 30_000 },
  );
  const row = await api.get(`/api/subshells/${disconnectPaneId}`);
  expect(row.ok(), await row.text()).toBe(true);
  const pane = (await row.json()) as { status: string; alive: boolean };
  expect(pane.alive).toBe(false);
  expect(pane.status).toBe("running");
});
