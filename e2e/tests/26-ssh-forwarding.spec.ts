import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, type PlaywrightWorkerArgs, test } from "@playwright/test";
import { missingSshBins, SSH_FIXTURE_ALIAS } from "../fixtures/sshd";
import { startContainerSshFixture } from "../fixtures/sshd-container";
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
 * The destination is the TESTCONTAINERS sshd: B is this worker's own machine
 * (or job container), D is a sibling container. Where a row's TARGET lives
 * follows ssh's own semantics, and with two machines those ends finally
 * differ: a `-L`/`-D` connection's far end opens at the DESTINATION, so the
 * marker those two read comes from a tiny `darkhttpd` the spec starts inside
 * the container; a `-R` connection's far end opens at the CLIENT, so that
 * row's target is this spec's own in-process marker server. Each listener is
 * read from the side that owns it:
 *  - `-L`: curl the loopback port on the connecting side and read the marker
 *    the destination's httpd answers with (if the clear survived, or the
 *    block never matched, the port stays unbound and curl fails),
 *  - `-D`: `curl --socks5-hostname` THROUGH the SOCKS listener fetches the
 *    same marker from the same httpd (a proxy that never bound refuses the
 *    connect),
 *  - `-R`: sshd opened this listener ON THE CONTAINER, so the read runs
 *    inside it (a `container.exec` curl) and the bytes come back through the
 *    tunnel from this spec's marker server. The fixture sshd runs
 *    `GatewayPorts clientspecified`, and a row that names no bind address
 *    still lands on loopback (spec §6) - a dial to the container's own
 *    interface address must draw a refusal on that port.
 *
 * Then the wide-bind gate as a door, not a copy: wide rows are refused
 * (403 `SSH_FORWARD_BIND_DENIED`) before the node's setting exists, and after
 * the owner flips it the launch is accepted, the rendered file spells both
 * wide binds, and each escape is proved where a loopback bind cannot follow:
 * the wide `-L` answers a dial to this machine's INTERFACE address (a socket
 * bound to 127.0.0.1 does not exist at that address, whoever dials it), and
 * the wide `-R` answers the same kind of dial INSIDE the destination container
 * at the container's interface address. That dial from the worker, not from
 * the container, is measured CI doctrine: the e2e job itself runs in a
 * container, and sibling testcontainers do not route to the job's network.
 * The audit row's bounded forwards summary is checked beside the bytes it
 * describes.
 *
 * Like spec 23, the container legs need a Docker daemon: with none, beforeAll
 * fails rather than quietly skipping. The binary gate is spec 22's: no ssh
 * binaries, skip LOUDLY.
 */

const ROOT = path.join(import.meta.dirname, "..", "..");
const BACKEND_DIR = path.join(ROOT, "apps", "server", "api");
const ORIGIN = `http://127.0.0.1:${PORTS.forwards}`;

const READY_TIMEOUT = 60_000;
const SPAWN_TIMEOUT = 60_000;

/** The marker the target server answers with; every leg expects exactly this. */
const MARKER = "FORWARD-MARKER-OK\n";

/**
 * Ports sshd binds INSIDE the destination container for the `-R` legs. They
 * are not probed for freedom like the B-side ports are: the container's
 * network namespace is freshly started for this spec and holds nothing but
 * sshd and these forwards, so a clash would mean the fixture itself broke.
 */
const DEST_BLANK_R_PORT = 18801;
const DEST_WIDE_R_PORT = 18802;

/**
 * The container's own marker server, started below with `darkhttpd`. `-L`
 * and `-D` rows open their far end ON THE DESTINATION, so this is the target
 * they point at (loopback inside the container).
 */
const DEST_MARKER_PORT = 8080;

// The client-side binaries only: the destination now runs in the container,
// so this host's own sshd is no longer something this spec needs to find.
const missing = missingSshBins().filter((bin) => bin !== "sshd");
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

/**
 * This machine's first routable interface address - the address a wide `-L`
 * bind is dialed AT. A socket bound to 127.0.0.1 simply does not exist there,
 * so "answers at this address" is the bind-scope proof no matter who dials.
 * The dialer is deliberately NOT the destination container: the CI e2e job
 * runs in its own docker network, and sibling testcontainers cannot route to
 * a container on a different user-defined network (measured on CI, 2026-10-16
 * - the container-to-job dial gets connection refused). The worker dialing
 * its own interface address tests exactly the same socket fact from the same
 * namespace, in both topologies.
 */
function connectingMachineAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.address.split(".").length === 4) return entry.address;
    }
  }
  throw new Error("no routable IPv4 interface to dial a wide-bound port at");
}

/** What ssh printed into the pane, plus what actually LISTENs, for a leg that timed out. */
function forwardDiagnostics(inst: ForwardInstance, id: string, port: number): string {
  const parts: string[] = [];
  try {
    parts.push(`pane tail: ${readFileSync(path.join(inst.dataDir, "subshells", `${id}.log`), "utf8").slice(-1500)}`);
  } catch {
    parts.push("pane: (no log)");
  }
  // A host without iproute2 answers with no stdout at all; the diagnostics
  // must not throw over the real failure's message it exists to carry.
  const ss = spawnSync("ss", ["-ltn"], { encoding: "utf8" });
  parts.push(
    `listeners on ${String(port)}: ${
      (ss.stdout ?? "")
        .split("\n")
        .filter((l) => l.includes(`:${String(port)}`))
        .join(" | ") || "none (or ss unavailable)"
    }`,
  );
  return parts.join("\n");
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
  let fixture: Awaited<ReturnType<typeof startContainerSshFixture>> | undefined;
  let fixtureRoot: string | undefined;
  let agentPid: number | undefined;
  let adminRef: APIRequestContext | undefined;
  let targetPort = 0;
  /** The container's own non-loopback address, read from inside it once at boot. */
  let destAddress = "";
  const livePaneIds: string[] = [];

  /** Curl run INSIDE the destination container: the reader for every port sshd bound there. */
  async function destFetch(url: string): Promise<string | null> {
    const fx = fixture;
    if (!fx) throw new Error("beforeAll did not run");
    const res = await fx.exec(["sh", "-c", `curl -s --max-time 10 "${url}"`]);
    return res.exitCode === 0 ? res.output : null;
  }

  test.beforeAll(async ({ playwright }) => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "subshell-e2e-fwdtier-"));
    fixture = await startContainerSshFixture(fixtureRoot);

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

    // The address the container itself answers on: a dial there cannot reach a
    // loopback bind, which is what makes it the wide-bind proof's client end.
    const addrProbe = await fixture.exec(["ip", "-4", "-o", "addr", "show", "dev", "eth0"]);
    destAddress = addrProbe.output.match(/inet (\d+\.\d+\.\d+\.\d+)\//)?.[1] ?? "";
    if (destAddress === "") throw new Error(`container eth0 address unparseable: ${addrProbe.output}`);

    // The far end `-L`/`-D` open at: darkhttpd inside the container serving
    // the same marker this spec's own server answers with. It runs because
    // the forwarded connection's target host is resolved THERE, not on the
    // connecting side - with B and D finally apart, that distinction is part
    // of what the spec proves. The daemonizing `&` sits INSIDE a brace group:
    // a trailing `&` would background the whole `&&` chain and make sh exit 0
    // whatever mkdir or printf does, so the exit-code guard below would
    // check nothing. With the group, only the server is backgrounded and the
    // guard sees a failed setup; the poll behind it still proves it answers.
    const httpd = await fixture.exec([
      "sh",
      "-c",
      `mkdir -p /var/www && printf '${MARKER.trim()}\\n' > /var/www/index.html && { nohup darkhttpd /var/www --port ${String(DEST_MARKER_PORT)} >/dev/null 2>&1 & }`,
    ]);
    if (httpd.exitCode !== 0) throw new Error(`container marker httpd failed to start: ${httpd.output}`);
    // Prove it answers BEFORE any leg depends on it: a silent background
    // daemon failure would otherwise surface as a forward that "never
    // answered" and send the next reader hunting for a bug in ssh.
    await pollUntil(
      "the container's own marker httpd never answered",
      async () => (await destFetch(`http://127.0.0.1:${String(DEST_MARKER_PORT)}/`)) === MARKER,
      15_000,
    );

    await startForwardBackend(fixture.sshConfigHome, agentEnv.SSH_AUTH_SOCK);
    adminRef = await freshCtx(playwright);
    const signUp = await adminRef.post("/api/auth/sign-up/email", { data: ADMIN });
    expect(signUp.ok(), await signUp.text()).toBe(true);
    const enable = await adminRef.put("/api/nodes/local/ssh-enabled", { data: { on: true } });
    expect(enable.ok(), await enable.text()).toBe(true);
    // The marker server the `-R` rows point at: a `-R` connection's far end
    // opens on the CLIENT side, so sshd's forwarded connection lands here.
    // (The `-L`/`-D` rows point at the container's own httpd instead.)
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
    const launch = await admin.post("/api/ssh/launch", {
      data: {
        node: "local",
        destination: SSH_FIXTURE_ALIAS,
        name: "e2e-fwd-three-kinds",
        forwards: [
          {
            kind: "local",
            listenPort: localListen,
            bindHost: null,
            targetHost: "127.0.0.1",
            targetPort: DEST_MARKER_PORT,
          },
          { kind: "dynamic", listenPort: socksListen, bindHost: null, targetHost: null, targetPort: null },
          {
            kind: "remote",
            listenPort: DEST_BLANK_R_PORT,
            bindHost: null,
            targetHost: "127.0.0.1",
            targetPort,
          },
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
    expect(config).toContain(`LocalForward 127.0.0.1:${String(localListen)} 127.0.0.1:${String(DEST_MARKER_PORT)}`);
    expect(config).toContain(`DynamicForward 127.0.0.1:${String(socksListen)}`);
    expect(config).toContain(`RemoteForward ${String(DEST_BLANK_R_PORT)} 127.0.0.1:${String(targetPort)}`);
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
    try {
      await pollUntil(
        () => `-L forward on 127.0.0.1:${String(localListen)} never answered`,
        async () => (await fetchText(`http://127.0.0.1:${String(localListen)}/`)) === MARKER,
      );
    } catch (err) {
      throw new Error(`${String(err)}\n${forwardDiagnostics(inst, subshellId, localListen)}`);
    }
    // ...and the loopback-bound port does NOT exist at the machine's interface
    // address: the same dial the wide bind answers in test 2 is refused here.
    // Bind scope, shown as a pair on one machine, no routing assumptions.
    expect(await fetchText(`http://${connectingMachineAddress()}:${String(localListen)}/`)).toBeNull();
    // -D: through the SOCKS listener; the chosen target resolves where a
    // SOCKS-over-ssh proxy resolves it - on the destination - so it names
    // the container's httpd.
    await pollUntil(
      () => `-D SOCKS listener on 127.0.0.1:${String(socksListen)} never proxied`,
      async () => (await socksFetch(socksListen, `http://127.0.0.1:${String(DEST_MARKER_PORT)}/`)) === MARKER,
    );
    // -R: sshd's listener ON THE CONTAINER; the bytes come back through the
    // tunnel to this spec's marker server. Read from inside D, because D owns
    // the port and this spec is no longer on D's loopback.
    await pollUntil(
      () => `-R forward on the destination never answered on ${String(DEST_BLANK_R_PORT)}`,
      async () => (await destFetch(`http://127.0.0.1:${String(DEST_BLANK_R_PORT)}/`)) === MARKER,
    );
    // The blank bind rides the destination's default, and under
    // `GatewayPorts clientspecified` that default is loopback: the SAME port
    // refuses a dial to the container's interface address. One machine
    // answers, the other address does not - the bind really is narrow.
    expect(await destFetch(`http://${destAddress}:${String(DEST_BLANK_R_PORT)}/`)).toBeNull();

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
        { kind: "local", listen: `127.0.0.1:${String(localListen)}`, target: `127.0.0.1:${String(DEST_MARKER_PORT)}` },
        { kind: "dynamic", listen: `127.0.0.1:${String(socksListen)}` },
        { kind: "remote", listen: String(DEST_BLANK_R_PORT), target: `127.0.0.1:${String(targetPort)}` },
      ],
    });
  });

  test("a wide bind is refused before the switch and bound after it", async () => {
    test.setTimeout(240_000);
    const admin = adminRef;
    if (!admin || !fixture) throw new Error("beforeAll did not run");
    const fx = fixture;
    const inst = instance;
    if (!inst) throw new Error("no backend instance");

    const wideListen = await freePort();
    const deniedRows = [
      {
        kind: "local",
        listenPort: wideListen,
        bindHost: "0.0.0.0",
        targetHost: "127.0.0.1",
        targetPort: DEST_MARKER_PORT,
      },
    ];

    // Before: the refusal is pre-launch and names itself; nothing was dialed.
    const denied = await admin.post("/api/ssh/launch", {
      data: { node: "local", destination: SSH_FIXTURE_ALIAS, name: "e2e-fwd-wide-denied", forwards: deniedRows },
    });
    expect(denied.status()).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("SSH_FORWARD_BIND_DENIED");

    // The owner flips the machine's own switch.
    const flipped = await admin.put("/api/nodes/local/ssh-wide-forwards", { data: { on: true } });
    expect(flipped.ok(), await flipped.text()).toBe(true);
    expect(((await flipped.json()) as { sshWideForwards: boolean }).sshWideForwards).toBe(true);

    // After: the same row launches, plus the remote twin, so the wide escape
    // gets proved on BOTH machines the feature touches.
    const launch = await admin.post("/api/ssh/launch", {
      data: {
        node: "local",
        destination: SSH_FIXTURE_ALIAS,
        name: "e2e-fwd-wide-accepted",
        forwards: [
          ...deniedRows,
          {
            kind: "remote",
            listenPort: DEST_WIDE_R_PORT,
            bindHost: "0.0.0.0",
            targetHost: "127.0.0.1",
            targetPort,
          },
        ],
      },
    });
    expect(launch.status(), await launch.text()).toBe(201);
    const subshellId = ((await launch.json()) as { subshell: { id: string } }).subshell.id;
    livePaneIds.push(subshellId);

    const configPath = path.join(inst.dataDir, "ssh", subshellId, "config");
    await pollUntil(`the wide-bind config never appeared at ${configPath}`, () => existsSync(configPath));
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain(`LocalForward 0.0.0.0:${String(wideListen)} 127.0.0.1:${String(DEST_MARKER_PORT)}`);
    expect(config).toContain(`RemoteForward 0.0.0.0:${String(DEST_WIDE_R_PORT)} 127.0.0.1:${String(targetPort)}`);

    // This is the second ssh session against the container; the forwards bind
    // only once its shell is up.
    await pollUntil(
      () => `the second sshd session never reached its shell for ${subshellId}`,
      () => (readFileSync(fx.logPath, "utf8").match(/Starting session: shell/g) ?? []).length >= 2,
      READY_TIMEOUT,
    );

    // The B side still answers its own loopback curl (unchanged from before
    // the switch - the wide bind is an ADDITION, not a replacement).
    await pollUntil(
      () => `wide forward on ${String(wideListen)} never answered locally`,
      async () => (await fetchText(`http://127.0.0.1:${String(wideListen)}/`)) === MARKER,
    );
    // THE connecting-side escape: the wide-bound listener answers a dial to
    // this machine's interface address, where a 127.0.0.1 bind does not exist
    // at all. Pre-switch this port bound loopback only, and test 1 dials the
    // loopback-bound -L port at this same address to show it refused.
    await pollUntil(
      () =>
        `the wide -L port never answered at the interface address ${connectingMachineAddress()}:${String(wideListen)}`,
      async () => (await fetchText(`http://${connectingMachineAddress()}:${String(wideListen)}/`)) === MARKER,
    );
    // And the wide -R escape on the destination's own side: the same kind of
    // dial that refused the blank bind now answers, at the container's
    // interface address.
    await pollUntil(
      () => `the wide -R port never answered at the container's interface address`,
      async () => (await destFetch(`http://${destAddress}:${String(DEST_WIDE_R_PORT)}/`)) === MARKER,
    );
  });
});
