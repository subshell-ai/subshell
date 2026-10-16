import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, type PlaywrightWorkerArgs, test } from "@playwright/test";
import { missingSshBins, SSH_FIXTURE_ALIAS, type SshFixture, startSshFixture } from "../fixtures/sshd";
import { PORTS } from "../ports";
import { shortTmuxBase } from "../stack";

/**
 * The port-forwards legs of spec 2026-10-15 §9: a REAL sshd, a REAL launch,
 * and listeners this spec curls. Everything unit-level already answers the
 * question "does the rendered file contain the forward lines?" - including a
 * real `ssh -G` parse. What only a bound port can answer is the fact the
 * whole render design rests on: that with `ClearAllForwardings` dropped from
 * the policy block, ssh really binds the approved listens and traffic really
 * flows, and that a row nobody approved binds nothing.
 *
 * The three kinds each get a leg on ONE launch:
 *  - `-L`: curl the loopback port on the connecting side and read the marker
 *    the target server answers with (if the clear survived, or the block
 *    never matched, the port stays unbound and curl fails),
 *  - `-D`: `curl --socks5-hostname` THROUGH the SOCKS listener fetches the
 *    same marker (a proxy that never bound refuses the connect),
 *  - `-R`: curl the listen port sshd opened on the destination side; the
 *    bytes come back through the tunnel to the target server, proving the
 *    remote forward was accepted and bound (the fixture sshd keeps the
 *    OpenSSH default `GatewayPorts no`, so its bind is loopback, which is
 *    exactly what a null `bindHost` means to ride - spec §6).
 *
 * Then the wide-bind gate as a door, not a copy: the same kind of row naming
 * `0.0.0.0` is refused (403 `SSH_FORWARD_BIND_DENIED`) before the node's
 * setting exists, and after the owner flips it the launch is accepted, the
 * rendered file spells the wide bind, and the port answers. The audit row's
 * bounded forwards summary is checked beside the bytes it describes.
 *
 * B/D are the same host here (the fixture sshd runs unprivileged beside the
 * backend), which the legs tolerate: they assert a LISTEN exists that only
 * the approved forward could have created, and that fact does not depend on
 * two machines. The binary gate is spec 22's: no ssh binaries, skip LOUDLY.
 */

const ROOT = path.join(import.meta.dirname, "..", "..");
const BACKEND_DIR = path.join(ROOT, "apps", "server", "api");
const ORIGIN = `http://127.0.0.1:${PORTS.forwards}`;

const READY_TIMEOUT = 60_000;
const SPAWN_TIMEOUT = 60_000;

/** The marker the target server answers with; every leg expects exactly this. */
const MARKER = "FORWARD-MARKER-OK\n";

const missing = missingSshBins();
test.skip(
  missing.length > 0 || spawnSync("curl", ["--version"], { encoding: "utf8" }).status !== 0,
  `spec 26 needs real ssh binaries${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""} and curl for the SOCKS leg`,
);

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

/** A loopback ephemeral port, freed the instant it is named (the spec's own copy of the fixture's trick). */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** GET as a yes/no bytes answer; connection refused (an unbound forward) is just "not yet". */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Fetch through a SOCKS5 listener (remote-resolving, the way `-D` is meant to
 * be used). ASYNC on purpose: the marker server lives in this worker process,
 * and a synchronous curl would park the event loop the server needs to
 * answer - the forward would stall looking like a refusal to bind.
 */
async function socksFetch(proxyPort: number, url: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawn("curl", ["-s", "--max-time", "10", "--socks5-hostname", `127.0.0.1:${String(proxyPort)}`, url]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

interface ForwardInstance {
  child: ReturnType<typeof spawn>;
  dir: string;
  dataDir: string;
  tmuxBase: string;
}

/** Boots the spec's OWN backend on `PORTS.forwards`, HOME + agent socket in its env (spec 22's reason). */
async function startForwardBackend(fixtureHome: string, sshAuthSock: string): Promise<ForwardInstance> {
  stopForwardBackend();
  const dir = mkdtempSync(path.join(tmpdir(), "subshell-e2e-fwd-"));
  const dataDir = path.join(dir, "data");
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true });

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "development",
    SUBSHELL_TEST_MODE: "false",
    SUBSHELL_SERVER_CONFIG_DIR: dir,
    SERVER_PORT: String(PORTS.forwards),
    HOST: "127.0.0.1",
    DATABASE_PATH: path.join(dir, "subshell.db"),
    SUBSHELL_SERVER_DATA_DIR: dataDir,
    APP_BASE_URL: ORIGIN,
    BETTER_AUTH_SECRET: "e2e-secret-not-used-outside-tests-0000000000",
    SUBSHELL_PLUGIN_REGISTRY_URL: `http://127.0.0.1:${PORTS.fakeRegistry}`,
    SUBSHELL_RELEASE_URL: "",
    TMUX_TMPDIR: tmuxBase,
    HOME: fixtureHome,
    SSH_AUTH_SOCK: sshAuthSock,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
    env,
  });
  child.unref();
  const inst: ForwardInstance = { child, dir, dataDir, tmuxBase };
  instance = inst;

  const deadline = Date.now() + READY_TIMEOUT;
  for (;;) {
    try {
      const res = await fetch(`${ORIGIN}/api/setup/status`);
      if (res.ok) {
        const body = (await res.json()) as { needsSetup: boolean };
        if (!body.needsSetup) throw new Error("[e2e] forwarding instance: port already set up (leaked run)");
        return inst;
      }
    } catch (err) {
      if ((err as Error).message.includes("port already set up")) throw err as Error;
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`[e2e] forwarding instance did not become ready at ${ORIGIN}`);
    await sleep(300);
  }
}

let instance: ForwardInstance | undefined;

function stopForwardBackend(): void {
  const inst = instance;
  if (!inst) return;
  instance = undefined;
  try {
    if (inst.child.pid) process.kill(-inst.child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
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

const ADMIN = { name: "Fwd Admin", email: "fwd-admin@subshell.test", password: "e2e-fwd-admin-pass-1" } as const;

function freshCtx(playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
}

test.describe("ssh port forwards (spec 2026-10-15)", () => {
  test.describe.configure({ mode: "serial" });

  const leaks: string[] = [];
  const specTeardown: (() => Promise<void> | void)[] = [];
  let fixture: SshFixture | undefined;
  let fixtureRoot: string | undefined;
  let agentPid: number | undefined;
  let adminRef: APIRequestContext | undefined;
  let targetPort = 0;
  const livePaneIds: string[] = [];

  test.beforeAll(async ({ playwright }) => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "subshell-e2e-fwdtier-"));
    fixture = await startSshFixture(fixtureRoot);

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

    await startForwardBackend(fixture.sshConfigHome, agentEnv.SSH_AUTH_SOCK);
    adminRef = await freshCtx(playwright);
    const signUp = await adminRef.post("/api/auth/sign-up/email", { data: ADMIN });
    expect(signUp.ok(), await signUp.text()).toBe(true);
    const enable = await adminRef.put("/api/nodes/local/ssh-enabled", { data: { on: true } });
    expect(enable.ok(), await enable.text()).toBe(true);
    // The marker server every leg reads its bytes back from. It listens on
    // its own port; a leg's listen port proves the FORWARD bound a listener,
    // because only the tunnel connects that listener to this server.
    targetPort = await freePort();
    const target = createServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(MARKER);
    });
    target.listen(targetPort, "127.0.0.1");
    specTeardown.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
  });

  test.afterAll(async () => {
    for (const [label, id] of [...livePaneIds].reverse().entries()) {
      try {
        if (adminRef) {
          await adminRef.post(`/api/subshells/${id}/terminate`);
          await adminRef.delete(`/api/subshells/${id}`);
        }
      } catch (err) {
        leaks.push(`cleanup row ${label}: ${String(err)}`);
      }
    }
    for (const close of specTeardown.reverse()) {
      try {
        await close();
      } catch (err) {
        leaks.push(`teardown: ${String(err)}`);
      }
    }
    try {
      await adminRef?.dispose();
    } catch (err) {
      leaks.push(`admin ctx: ${String(err)}`);
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
      stopForwardBackend();
    } catch (err) {
      leaks.push(`backend stop: ${String(err)}`);
    }
    if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
    if (leaks.length > 0) console.error(`[26-ssh-forwarding] cleanup problems: ${leaks.join("; ")}`);
  });

  test("an approved -L, -D, and -R bind real listeners; the rendered config carries the block without the clear; the audit names the rows", async () => {
    test.setTimeout(240_000);
    const admin = adminRef;
    if (!admin || !fixture) throw new Error("beforeAll did not run");
    const fx = fixture; // Local const: the poll closures below cannot narrow the outer `let`.
    const inst = instance;
    if (!inst) throw new Error("no backend instance");

    const localListen = await freePort();
    const socksListen = await freePort();
    const remoteListen = await freePort();
    const launch = await admin.post("/api/ssh/launch", {
      data: {
        node: "local",
        destination: SSH_FIXTURE_ALIAS,
        name: "e2e-fwd-three-kinds",
        forwards: [
          { kind: "local", listenPort: localListen, bindHost: null, targetHost: "127.0.0.1", targetPort },
          { kind: "dynamic", listenPort: socksListen, bindHost: null, targetHost: null, targetPort: null },
          { kind: "remote", listenPort: remoteListen, bindHost: null, targetHost: "127.0.0.1", targetPort },
        ],
      },
    });
    expect(launch.status(), await launch.text()).toBe(201);
    const subshellId = ((await launch.json()) as { subshell: { id: string } }).subshell.id;
    livePaneIds.push(subshellId);

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

    // The rendered config: the exact-destination block spells all three
    // lines, the `Host *` policy stands (Tunnel no etc.), and the clear line
    // the rows made obsolete is GONE - the whole §5 argument in one file.
    const configPath = path.join(inst.dataDir, "ssh", subshellId, "config");
    await pollUntil(`the rendered ssh config never appeared at ${configPath}`, () => existsSync(configPath));
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("Tunnel no");
    expect(config).not.toContain("ClearAllForwardings");
    expect(config).toContain(`LocalForward 127.0.0.1:${String(localListen)} 127.0.0.1:${String(targetPort)}`);
    expect(config).toContain(`DynamicForward 127.0.0.1:${String(socksListen)}`);
    expect(config).toContain(`RemoteForward ${String(remoteListen)} 127.0.0.1:${String(targetPort)}`);
    expect(config.indexOf("Host *")).toBeLessThan(config.indexOf("# User-declared port forwards"));
    expect(config).toContain("# User-declared port forwards, approved at launch (spec 2026-10-15).");

    // The sshd shell must be up before the legs read bytes: forwards bind
    // only after authentication completes ("Starting session" as spec 22's
    // truth source).
    await pollUntil(
      () => `sshd never reported a shell for ${subshellId}`,
      () => /Starting session: shell/.test(readFileSync(fx.logPath, "utf8")),
      READY_TIMEOUT,
    );

    // -L: the connecting side's listener answers with the target's bytes.
    await pollUntil(
      () => `-L forward on 127.0.0.1:${String(localListen)} never answered`,
      async () => (await fetchText(`http://127.0.0.1:${String(localListen)}/`)) === MARKER,
    );
    // -D: through the SOCKS listener, remote-resolved like any SOCKS client.
    await pollUntil(
      () => `-D SOCKS listener on 127.0.0.1:${String(socksListen)} never proxied`,
      async () => (await socksFetch(socksListen, `http://127.0.0.1:${String(targetPort)}/`)) === MARKER,
    );
    // -R: sshd's own listener on the destination side; the bytes come back
    // through the tunnel to the target server.
    await pollUntil(
      () => `-R forward on the destination never answered on ${String(remoteListen)}`,
      async () => (await fetchText(`http://127.0.0.1:${String(remoteListen)}/`)) === MARKER,
    );

    // The audit row names what the pane opened, bounded and secret-free:
    // kind + canonical listen per row, target for the two kinds that have one.
    const audit = await admin.get("/api/audit?limit=50");
    expect(audit.ok(), await audit.text()).toBe(true);
    const rows = (await audit.json()) as { action: string; metadata: unknown }[];
    const launchRow = rows.find((r) => r.action === "ssh.launch");
    expect(launchRow).toBeDefined();
    expect(launchRow?.metadata).toMatchObject({
      nodeId: "local",
      forwards: [
        { kind: "local", listen: `127.0.0.1:${String(localListen)}`, target: `127.0.0.1:${String(targetPort)}` },
        { kind: "dynamic", listen: `127.0.0.1:${String(socksListen)}` },
        { kind: "remote", listen: String(remoteListen), target: `127.0.0.1:${String(targetPort)}` },
      ],
    });
  });

  test("a wide bind is refused before the switch and bound after it", async () => {
    test.setTimeout(240_000);
    const admin = adminRef;
    if (!admin) throw new Error("beforeAll did not run");
    const inst = instance;
    if (!inst) throw new Error("no backend instance");

    const wideListen = await freePort();
    const rows = [{ kind: "local", listenPort: wideListen, bindHost: "0.0.0.0", targetHost: "127.0.0.1", targetPort }];

    // Before: the refusal is pre-launch and names itself; nothing was dialed.
    const denied = await admin.post("/api/ssh/launch", {
      data: { node: "local", destination: SSH_FIXTURE_ALIAS, name: "e2e-fwd-wide-denied", forwards: rows },
    });
    expect(denied.status()).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("SSH_FORWARD_BIND_DENIED");

    // The owner flips the machine's own switch.
    const flipped = await admin.put("/api/nodes/local/ssh-wide-forwards", { data: { on: true } });
    expect(flipped.ok(), await flipped.text()).toBe(true);
    expect(((await flipped.json()) as { sshWideForwards: boolean }).sshWideForwards).toBe(true);

    // After: the same row launches, the file spells the wide bind, and the
    // listener answers.
    const launch = await admin.post("/api/ssh/launch", {
      data: { node: "local", destination: SSH_FIXTURE_ALIAS, name: "e2e-fwd-wide-accepted", forwards: rows },
    });
    expect(launch.status(), await launch.text()).toBe(201);
    const subshellId = ((await launch.json()) as { subshell: { id: string } }).subshell.id;
    livePaneIds.push(subshellId);

    const configPath = path.join(inst.dataDir, "ssh", subshellId, "config");
    await pollUntil(`the wide-bind config never appeared at ${configPath}`, () => existsSync(configPath));
    expect(readFileSync(configPath, "utf8")).toContain(
      `LocalForward 0.0.0.0:${String(wideListen)} 127.0.0.1:${String(targetPort)}`,
    );
    await pollUntil(
      () => `wide forward on ${String(wideListen)} never answered`,
      async () => (await fetchText(`http://127.0.0.1:${String(wideListen)}/`)) === MARKER,
    );
  });
});
