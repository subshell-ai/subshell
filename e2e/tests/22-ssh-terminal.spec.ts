import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, type PlaywrightWorkerArgs, test } from "@playwright/test";
import { missingSshBins, SSH_FIXTURE_ALIAS, type SshFixture, startSshFixture } from "../fixtures/sshd";
import { PORTS } from "../ports";
import { shortTmuxBase } from "../stack";

/**
 * Milestone 1's proof (spec 2026-10-07 §14, plan 2 Task 9): a gated SSH pane,
 * end to end over REAL HTTP and a REAL sshd. No mocks anywhere on the path —
 * the fixture daemon (fixtures/sshd.ts) answers the connection, the backend
 * (this spec's own child, HOME pointed at the fixture account) resolves the
 * alias with a real `ssh -G`, renders a real config onto disk, and the pane
 * IS a real ssh session whose typed line is echoed by a real remote shell and
 * read back through the pane-log route.
 *
 * Why its own backend (the ports.ts `ssh` comment): bun caches `os.homedir()`
 * per process, and the ssh tier reads the connecting account's HOME for both
 * discovery and resolution — so the backend must be SPAWNED with
 * `HOME=<fixture home>`. The shared stack cannot carry that for the other
 * specs, and mutating THIS process's HOME would not reach the server anyway.
 *
 * Why the assertions land where they do:
 *  - owner input types `echo SSH-PANE-$((1+1))-OK`; only the REMOTE SHELL's
 *    evaluation prints `SSH-PANE-2-OK`, so the log match proves the round trip
 *    (the typed line itself never spells the result),
 *  - the sharee refusal is a CODE assertion (403 `SSH_OWNER_INPUT_ONLY`) and
 *    the sharee's own text must be ABSENT from the log ("before anything is
 *    typed" is a promise the route makes),
 *  - the config-dir cleanup is checked through the FILESYSTEM: the backend is
 *    a child process, but the spec passed it the data dir and both run on this
 *    host, so `<dataDir>/ssh/<id>` is directly observable here.
 *
 * Binaries: ssh / ssh-keygen / sshd must run unprivileged here. The fixture's
 * own gate (`missingSshBins`) decides; a host without them SKIPS LOUDLY (the
 * skip names the missing binaries), it never fails and never fakes a pass.
 * The CI e2e job installs openssh-client + openssh-server at runtime (the
 * "Ensure tmux, jq, and OpenSSH" step of test.yml); hosts without the
 * binaries still skip loudly rather than fake a pass.
 */

const ROOT = path.join(import.meta.dirname, "..", "..");
const BACKEND_DIR = path.join(ROOT, "apps", "server", "api");
const ORIGIN = `http://127.0.0.1:${PORTS.ssh}`;

/** Boot + sshd + agent + a real tmux ssh pane: budgets on spec 12's scale. */
const READY_TIMEOUT = 60_000;
const SPAWN_TIMEOUT = 60_000;
// The death sweep is a longer chain than a boot: typed `exit` -> the ssh
// process ends -> the tmux pane-died hook -> reportExit -> the server's local
// sweep rm. On a contended CI runner that whole chain overran the 60s boot
// budget once and passed on retry, so it gets its own, doubled. It never
// weakens the assertion: the dir must still be gone.
const SWEEP_TIMEOUT = 120_000;

const missing = missingSshBins();
test.skip(missing.length > 0, `SSH binaries absent on this host (${missing.join(", ")}) - spec 22 needs a real sshd`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until true or the deadline; on timeout throws the label's current text. */
async function pollUntil(
  label: string | (() => string),
  check: () => Promise<boolean> | boolean,
  timeoutMs = SPAWN_TIMEOUT,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(typeof label === "string" ? label : label());
    await sleep(500);
  }
}

interface SshInstance {
  child: ReturnType<typeof spawn>;
  /** The scratch root: config dir, temp DB, and the data dir whose `ssh/<id>` the spec watches. */
  dir: string;
  dataDir: string;
  tmuxBase: string;
}

/** Boots the spec's OWN backend on `PORTS.ssh`, with HOME + SSH_AUTH_SOCK in ITS env (see the header). */
async function startSshBackend(fixtureHome: string, sshAuthSock: string): Promise<SshInstance> {
  // Same orphan guard as spec 15: afterAll-like teardowns run per attempt, so
  // a dead retry's detached backend would hold :3201 for the next attempt.
  stopSshBackend();
  const dir = mkdtempSync(path.join(tmpdir(), "subshell-e2e-ssh-"));
  const dataDir = path.join(dir, "data");
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true });

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "development",
    SUBSHELL_TEST_MODE: "false",
    SUBSHELL_SERVER_CONFIG_DIR: dir,
    SERVER_PORT: String(PORTS.ssh),
    HOST: "127.0.0.1",
    DATABASE_PATH: path.join(dir, "subshell.db"),
    SUBSHELL_SERVER_DATA_DIR: dataDir,
    APP_BASE_URL: ORIGIN,
    BETTER_AUTH_SECRET: "e2e-secret-not-used-outside-tests-0000000000",
    SUBSHELL_PLUGIN_REGISTRY_URL: `http://127.0.0.1:${PORTS.fakeRegistry}`,
    SUBSHELL_RELEASE_URL: "",
    TMUX_TMPDIR: tmuxBase,
    // The two the ssh tier reads: HOME is the alias/config/known_hosts source
    // (discovery and `ssh -G` run as this account), SSH_AUTH_SOCK is what the
    // resolve may answer as the snapshot's agent socket.
    HOME: fixtureHome,
    SSH_AUTH_SOCK: sshAuthSock,
  };
  // A developer inside tmux must not hand the backend their session's pane
  // (spec 15's rule, same failure mode).
  delete env.TMUX;
  delete env.TMUX_PANE;

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
    env,
  });
  child.unref();
  const inst: SshInstance = { child, dir, dataDir, tmuxBase };
  instance = inst;

  const deadline = Date.now() + READY_TIMEOUT;
  for (;;) {
    try {
      const res = await fetch(`${ORIGIN}/api/setup/status`);
      if (res.ok) {
        const body = (await res.json()) as { needsSetup: boolean };
        if (!body.needsSetup) throw new Error("[e2e] ssh instance: port already set up (leaked run)");
        return inst;
      }
    } catch (err) {
      if ((err as Error).message.includes("port already set up")) throw err as Error;
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`[e2e] ssh instance did not become ready at ${ORIGIN}`);
    await sleep(300);
  }
}

/** The instance this attempt started (module-scope so the cleanup paths reach it across retries). */
let instance: SshInstance | undefined;

function stopSshBackend(): void {
  const inst = instance;
  if (!inst) return;
  instance = undefined;
  try {
    if (inst.child.pid) process.kill(-inst.child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  // The ssh pane's tmux server detached away from the backend's process group
  // (the stack.ts lesson), so kill by socket, then wipe the scratch dirs.
  for (const uidDir of readdirSafe(inst.tmuxBase)) {
    for (const socket of readdirSafe(path.join(inst.tmuxBase, uidDir))) {
      try {
        spawnSync("tmux", ["-S", path.join(inst.tmuxBase, uidDir, socket), "kill-server"]);
      } catch {
        // Best-effort per socket.
      }
    }
  }
  rmSync(inst.dir, { recursive: true, force: true });
  rmSync(path.dirname(inst.tmuxBase), { recursive: true, force: true });
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Mode without the type bits (what the 0600/0700 assertions read). */
function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

const ADMIN = { name: "SSH Admin", email: "ssh-admin@subshell.test", password: "e2e-ssh-admin-pass-1" } as const;
const MEMBER_PASSWORD = "e2e-ssh-member-pass-1";

/**
 * A fresh cookieless API context (spec 07's rule: a cookie-carrying /api/auth
 * call without an Origin is a CSRF 403; the first sign-in passes the guard and
 * seeds the jar, so each principal acts as itself).
 */
function freshCtx(playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
}

test("ssh pane: gated launch to the fixture sshd, owner input echoes from the remote shell, an edit sharee is refused, the config dir is swept", async ({
  playwright,
}) => {
  test.setTimeout(300_000);
  const nonce = test.info().retry;

  const leaks: string[] = [];
  let fixture: SshFixture | undefined;
  let fixtureRoot: string | undefined;
  let agentPid: number | undefined;
  // The refs the finally reaches for; the consts inside the try are what the
  // story calls (a let loses its non-undefined narrowing across the poll
  // closures, a const does not).
  let adminRef: APIRequestContext | undefined;
  let memberRef: APIRequestContext | undefined;
  let subshellId: string | undefined;

  // Trackers first: every allocation below is reclaimed by the finally even
  // when the story fails halfway (spec 12's no-leaves posture).
  try {
    // ── The fixture sshd + its keys + the alias HOME it writes under the root.
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "subshell-e2e-sshtier-"));
    fixture = await startSshFixture(fixtureRoot);

    // ── An ssh-agent holding the fixture's trusted key (plan-2 handoff): the
    // backend's resolve reads SSH_AUTH_SOCK from the SERVER process env. The
    // fixture's alias pins `IdentityAgent none`, so the pane dials with the
    // IdentityFile key and the agent is the env fact the resolve sees, not the
    // thing that authenticates - the agent-socket snapshot itself is pinned by
    // the service's unit tests.
    const agentOut = spawnSync("ssh-agent", ["-s"], { encoding: "utf8" });
    if (agentOut.status !== 0) throw new Error(`ssh-agent failed: ${agentOut.stderr}`);
    const agentEnv = Object.fromEntries(
      ["SSH_AUTH_SOCK", "SSH_AGENT_PID"].map((k) => [k, agentOut.stdout.match(new RegExp(`${k}=([^;]+)`))?.[1] ?? ""]),
    );
    agentPid = Number(agentEnv.SSH_AGENT_PID);
    if (!agentEnv.SSH_AUTH_SOCK || !Number.isInteger(agentPid) || agentPid <= 0) {
      throw new Error(`ssh-agent output unparseable: ${agentOut.stdout.slice(0, 200)}`);
    }
    const add = spawnSync("ssh-add", [fixture.trustedKeyPath], {
      env: { ...process.env, SSH_AUTH_SOCK: agentEnv.SSH_AUTH_SOCK },
      encoding: "utf8",
    });
    if (add.status !== 0) throw new Error(`ssh-add failed: ${add.stderr}`);

    // ── The backend, spawned with the fixture HOME + the agent socket in ITS env.
    const inst = await startSshBackend(fixture.sshConfigHome, agentEnv.SSH_AUTH_SOCK);

    // ── 1. Admin: the first registered account becomes admin (spec 01's rule
    // on this fresh instance), through the same endpoint the wizard's first
    // step posts. A cookieless context: the sign-up itself seeds the jar.
    adminRef = await freshCtx(playwright);
    const admin = adminRef;
    const signUp = await admin.post("/api/auth/sign-up/email", { data: ADMIN });
    expect(signUp.ok(), await signUp.text()).toBe(true);

    // ── 2. The gate: SSH is OFF by default - discovery refuses before the
    // switch, naming the one code for both gate causes.
    const gated = await admin.get("/api/ssh/aliases?node=local");
    expect(gated.status(), await gated.text()).toBe(403);
    expect(((await gated.json()) as { code: string }).code).toBe("SSH_GATE_OFF");

    const enable = await admin.put("/api/nodes/local/ssh-enabled", { data: { on: true } });
    expect(enable.ok(), await enable.text()).toBe(true);
    expect(((await enable.json()) as { sshEnabled: boolean }).sshEnabled).toBe(true);

    // ── 3. Discovery: the fixture's alias is the machine's own answer.
    const aliases = await admin.get("/api/ssh/aliases?node=local");
    expect(aliases.ok(), await aliases.text()).toBe(true);
    const { aliases: names } = (await aliases.json()) as { aliases: string[] };
    expect(names).toContain(SSH_FIXTURE_ALIAS);

    // ── 4. The launch: gate -> resolve (a real `ssh -G` as the fixture HOME)
    // -> compose -> create. 201 carries the pane view; its id is the config
    // dir's name.
    const launch = await admin.post("/api/ssh/launch", {
      data: { node: "local", destination: SSH_FIXTURE_ALIAS, name: `e2e-ssh-pane-${nonce}` },
    });
    expect(launch.status(), await launch.text()).toBe(201);
    subshellId = ((await launch.json()) as { subshell: { id: string } }).subshell.id;
    expect(subshellId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

    // The pane is genuinely alive: the ssh process is the pane, so alive is
    // the sshd handshake and the remote shell, not just a spawned tmux.
    await pollUntil(
      `ssh pane ${subshellId} never reached running+alive`,
      async () => {
        const res = await admin.get(`/api/subshells/${subshellId}`);
        if (!res.ok()) return false;
        const view = (await res.json()) as { status: string; alive: boolean };
        return view.status === "running" && view.alive === true;
      },
      READY_TIMEOUT,
    );

    // The rendered config, byte-checked where it lives (decision 4's path,
    // 0600 in a 0700 dir, and the M1 posture's own lines).
    const sshDir = path.join(inst.dataDir, "ssh", subshellId);
    const configPath = path.join(sshDir, "config");
    await pollUntil(`the rendered ssh config never appeared at ${configPath}`, () => existsSync(configPath));
    expect(modeOf(sshDir), "ssh pane dir").toBe(0o700);
    expect(modeOf(configPath), "ssh pane config").toBe(0o600);
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("StrictHostKeyChecking accept-new");
    expect(config).toContain(path.join(fixture.sshConfigHome, ".ssh", "known_hosts"));
    expect(config).toContain(fixture.trustedKeyPath);

    // ── 5. Owner input, typed through the ordinary REST input seam, answered
    // by the REMOTE shell: only bash's arithmetic prints the 2, so a match of
    // SSH-PANE-2-OK proves bytes travelled both ways through the real ssh.
    //
    // Typed only once the DAEMON has started the shell, not when the row says
    // alive: alive is stamped at create, and the pane's pty is still in the
    // pre-raw line discipline during the ssh handshake, which swallows the
    // Enter (observed: the text reached the remote prompt, the CR never did).
    // "Starting session: shell" is sshd's own LogLevel-VERBOSE line - the
    // fixture's truth source, environment-independent. The settle beat covers
    // the remote shell's init before its line editor exists.
    const daemonLog = fixture.logPath;
    await pollUntil(
      () =>
        `sshd never reported a shell for ${subshellId}; its log ends: ${readFileSync(daemonLog, "utf8").slice(-800)}`,
      () => /Starting session: shell/.test(readFileSync(daemonLog, "utf8")),
      READY_TIMEOUT,
    );
    await sleep(1_500);
    const typed = "echo SSH-PANE-$((1+1))-OK";
    const input = await admin.post(`/api/subshells/${subshellId}/input`, { data: { text: typed } });
    expect(input.ok(), await input.text()).toBe(true);
    let lastLogView = "";
    await pollUntil(
      () =>
        `the pane log never carried the remote shell's evaluated marker; last read: ${JSON.stringify(lastLogView.slice(-1200))}`,
      async () => {
        const res = await admin.get(`/api/subshells/${subshellId}/log`);
        if (!res.ok()) {
          lastLogView = `HTTP ${res.status()} ${(await res.text()).slice(0, 300)}`;
          return false;
        }
        lastLogView = ((await res.json()) as { lines: string[] }).lines.join("\n");
        return lastLogView.includes("SSH-PANE-2-OK");
      },
      READY_TIMEOUT,
    ).catch((err: Error) => {
      // Failure-only diagnostics: the RAW pipe-pane file (the route's strip may
      // differ from what the pane wrote) and the daemon's own log. Both live
      // on paths this spec owns; the happy path never pays for them.
      let raw = "";
      try {
        raw = readFileSync(path.join(inst.dataDir, "subshells", `${subshellId}.log`), "utf8").slice(-3000);
      } catch (e) {
        raw = String(e);
      }
      let daemon = "";
      try {
        daemon = fixture === undefined ? "(no fixture)" : readFileSync(fixture.logPath, "utf8").slice(-1500);
      } catch (e) {
        daemon = String(e);
      }
      throw new Error(`${err.message}\n--- raw log tail ---\n${raw}\n--- sshd log tail ---\n${daemon}`);
    });

    // ── 6. The owner-only input carve-out (spec §5.4): a second account with
    // the ordinary EVERYONE `edit` grant may act on a plain pane, and must
    // still be refused on an ssh pane - before anything is typed.
    const memberEmail = `ssh-member-${nonce}@subshell.test`;
    const created = await admin.post("/api/users", {
      data: { email: memberEmail, name: memberEmail, password: MEMBER_PASSWORD, role: "user" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const shared = await admin.put(`/api/subshells/${subshellId}/shares`, {
      data: { shares: [{ granteeUserId: null, permission: "edit" }] },
    });
    expect(shared.ok(), await shared.text()).toBe(true);

    memberRef = await freshCtx(playwright);
    const member = memberRef;
    const memberSignIn = await member.post("/api/auth/sign-in/email", {
      data: { email: memberEmail, password: MEMBER_PASSWORD },
    });
    expect(memberSignIn.ok(), await memberSignIn.text()).toBe(true);
    // The grant is real: the member sees the pane at `edit` (the refusal below
    // must be the SSH rule, not an invisibility or a missing grant).
    const memberView = await member.get(`/api/subshells/${subshellId}`);
    expect(memberView.ok(), await memberView.text()).toBe(true);
    expect(((await memberView.json()) as { access: string }).access).toBe("edit");

    const refused = await member.post(`/api/subshells/${subshellId}/input`, {
      data: { text: `echo NOT-YOUR-PANE-${nonce}` },
    });
    expect(refused.status(), await refused.text()).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("SSH_OWNER_INPUT_ONLY");

    // The refusal typed NOTHING: give any raced write a beat, then read the
    // whole log and require the sharee's marker to be absent.
    await sleep(1_000);
    const afterRefusal = await admin.get(`/api/subshells/${subshellId}/log`);
    expect(afterRefusal.ok()).toBe(true);
    expect(((await afterRefusal.json()) as { lines: string[] }).lines.join("\n")).not.toContain(
      `NOT-YOUR-PANE-${nonce}`,
    );

    // ── 7. The config dir is swept at the pane's death (decision 4): the
    // owner types `exit`, the ssh process ends on its own, and the tmux
    // pane-died hook lands on reportExit - whose local branch rm -rfs
    // <dataDir>/ssh/<id>. Natural death is THE sweep path to drive: a
    // terminate revokes the pane's token as it kills, so the hook it races
    // can answer 401, while here the token is still live when the hook fires
    // (measured: swept inside a second of the typed exit; the row parks at
    // status running, alive false). The backend is a separate process but on
    // THIS host with a data dir the spec itself chose, so the absence is
    // checked straight off the disk - in-proc vs child: CHILD, fs still
    // observable because the spec passed the path in.
    const exitLine = await admin.post(`/api/subshells/${subshellId}/input`, { data: { text: "exit" } });
    expect(exitLine.ok(), await exitLine.text()).toBe(true);
    await pollUntil(`ssh config dir ${sshDir} outlived the pane's own exit`, () => !existsSync(sshDir), SWEEP_TIMEOUT);

    // Retire the parked row (terminate accepts a dead pane, delete removes
    // it; the delete path's unlink-only artifact list has nothing left to
    // take, which is exactly what "swept" means here).
    const terminated = await admin.post(`/api/subshells/${subshellId}/terminate`);
    expect(terminated.ok(), await terminated.text()).toBe(true);
    const removed = await admin.delete(`/api/subshells/${subshellId}`);
    expect(removed.ok() || removed.status() === 404, await removed.text()).toBe(true);
    subshellId = undefined;
  } finally {
    // Row first (while the admin ctx still works), then the principals, then
    // the daemons. A mid-story failure leaves the pane alive on a tmux server
    // that lives under THIS attempt's tmuxBase, so the socket sweep inside
    // stopSshBackend() is what kills the ssh process when the row delete fails.
    if (subshellId !== undefined && adminRef) {
      try {
        const res = await adminRef.post(`/api/subshells/${subshellId}/terminate`);
        if (!res.ok() && res.status() !== 404) leaks.push(`cleanup terminate: HTTP ${res.status()}`);
        await adminRef.delete(`/api/subshells/${subshellId}`);
      } catch (err) {
        // The instance is going away anyway; the temp dir rm below is the real backstop.
        leaks.push(`cleanup row: ${String(err)}`);
      }
    }
    for (const [label, p] of [
      ["admin ctx", adminRef],
      ["member ctx", memberRef],
    ] as const) {
      try {
        await p?.dispose();
      } catch (err) {
        leaks.push(`${label} dispose: ${String(err)}`);
      }
    }
    if (agentPid !== undefined) {
      try {
        process.kill(agentPid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    try {
      await fixture?.stop();
    } catch (err) {
      leaks.push(`sshd fixture stop: ${String(err)}`);
    }
    try {
      stopSshBackend();
    } catch (err) {
      leaks.push(`backend stop: ${String(err)}`);
    }
    if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
    if (leaks.length > 0) console.error(`[22-ssh-terminal] cleanup problems: ${leaks.join("; ")}`);
  }
});
