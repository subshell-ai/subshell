import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userInfo } from "node:os";
import { buildSshInvocation, remoteCommandLine, renderSshConfigContents, sshChildEnv } from "../ssh-render.js";
import { runSshProcess } from "../ssh-spawn.js";
import { classifySshFailure } from "../ssh-diagnose.js";
import { SshRunSupervisor } from "../ssh-run-supervisor.js";
import { makeDigest, makeRunId, tempRoot, cleanup } from "./helpers.js";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";

/**
 * The real-daemon suite (brief: "real isolated sshd fixture … gated on sshd
 * presence with a loud skip line"). Temp HOME, generated host key + trusted
 * client key, loopback ports, own pid tracked, cleanup only of resources the
 * fixture started (SSH-SUPPORT.md §6: "Never use the live instance or a
 * developer's SSH configuration" — this fixture's sshd_config sets no system
 * paths, its keys are generated, its ports are loopback and ephemeral).
 *
 * Covers the trust behaviors that only a real OpenSSH answers honestly:
 * unknown key refusal, changed key refusal (fail closed, never re-trust), a
 * benign probe run through the FULL rendered path, and the ProxyJump claim
 * the renderer depends on: that the `-F` file — and ONLY that file — is what
 * the jump children read (the fixture's HOME carries no `.ssh` at all, so any
 * ambient read would fail closed and the jump test would go red).
 */

const HAVE_SSH = Bun.which("ssh") !== null && Bun.which("ssh-keygen") !== null && Bun.which("sshd") !== null;
if (!HAVE_SSH) {
  // A loud skip line, not a silent green: on a host without sshd this whole
  // trust surface is UNVERIFIED, and the suite result should say so.
  console.warn("[ssh-sshd-fixture] sshd/ssh-keygen/ssh not present on this host: REAL-DAEMON SSH TESTS SKIPPED");
}

let root: string;
let home: string; // the fixture's fake HOME — deliberately has NO .ssh dir
let sshBin: string;
let sshdPid: number | null = null;
let sshd2Pid: number | null = null;
let port = 0;
let port2 = 0;
let clientKey = "";
let knownHosts = "";
let knownHosts2 = "";
let account = "";

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const p = 20_000 + Math.floor(Math.random() * 40_000);
    try {
      const srv = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
      srv.unref?.();
      srv.stop();
      await Bun.sleep(20);
      return p;
    } catch {
      // taken: try another
    }
  }
  throw new Error("no free loopback port");
}

async function startSshd(dir: string, listenPort: number, pidFile: string, hostKeyFile: string): Promise<number> {
  mkdirSync(dir, { recursive: true });
  const cfg = [
    `Port ${listenPort}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKeyFile}`,
    `PidFile ${pidFile}`,
    `AuthorizedKeysFile ${join(home, ".ssh", "authorized_keys")}`,
    "StrictModes no",
    "UsePAM no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    "PermitUserEnvironment no",
    "PrintMotd no",
    "LogLevel VERBOSE",
  ].join("\n");
  writeFileSync(join(dir, "sshd_config"), cfg);
  // sshd -e means "log to stderr" and takes NO file argument: the fixture
  // redirects the child's stderr into its own file.
  const logFd = openSync(join(dir, "sshd.log"), "w");
  const proc = Bun.spawn(["/usr/sbin/sshd", "-D", "-f", join(dir, "sshd_config"), "-e"], {
    stdout: "ignore",
    stderr: logFd,
    stdin: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  closeSync(logFd);
  // Readiness probe: KEEP trying the port through ssh itself until the answer
  // is no longer "nobody is listening" (an auth refusal means the daemon is
  // up — exactly the fact we are waiting for).
  for (let i = 0; i < 100; i++) {
    const probe = Bun.spawnSync([Bun.which("ssh")!, "-p", String(listenPort), "-o", "BatchMode=yes", "-o", "ConnectTimeout=1", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "127.0.0.1", "true"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const err = probe.stderr.toString();
    if (!/Connection refused|connect to host 127\.0\.0\.1 port|Connection timed out/i.test(err)) return proc.pid;
    await Bun.sleep(100);
  }
  const log = readFileSync(join(dir, "sshd.log"), "utf8").slice(-2000);
  throw new Error(`sshd did not come up on 127.0.0.1:${listenPort}\n${log}`);
}

function snapshotFor(p: number, overrides: Partial<SshConnectionSnapshotWire> = {}): SshConnectionSnapshotWire {
  return {
    alias: "fixture",
    host: "127.0.0.1",
    user: account,
    port: p,
    identityFiles: [clientKey],
    certificateFiles: [],
    authAgentSocket: null,
    knownHostsFiles: [knownHosts],
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
    ...overrides,
  };
}

beforeAll(async () => {
  if (!HAVE_SSH) return;
  root = tempRoot("subshell-sshd-");
  home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true }); // authorized_keys only — NO config, NO trust files of the developer
  account = userInfo().username;
  sshBin = Bun.which("ssh")!;
  // host key + client key
  Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(root, "hostkey")]);
  Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(root, "clientkey")]);
  clientKey = join(root, "clientkey");
  writeFileSync(join(home, ".ssh", "authorized_keys"), `${readFileSync(`${clientKey}.pub`, "utf8").trim()}\n`);
  knownHosts = join(root, "known_hosts");
  port = await freePort();
  port2 = await freePort();
  sshdPid = await startSshd(join(root, "sshd1"), port, join(root, "sshd1.pid"), join(root, "hostkey"));
  sshd2Pid = await startSshd(join(root, "sshd2"), port2, join(root, "sshd2.pid"), join(root, "hostkey"));
  // rewrite the known_hosts lines with the [host]:port authority ssh will check
  const keyTypeAndBlob = readFileSync(join(root, "hostkey.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
  writeFileSync(knownHosts, `[127.0.0.1]:${port} ${keyTypeAndBlob}\n`);
  knownHosts2 = join(root, "known_hosts2");
  writeFileSync(knownHosts2, `[127.0.0.1]:${port} ${keyTypeAndBlob}\n[127.0.0.1]:${port2} ${keyTypeAndBlob}\n`);
  chmodSync(root, 0o700);
}, 90_000);

afterAll(async () => {
  // keygen + two daemon starts + readiness probes are process-spawn work the
  // default 5 s hook budget cannot cover.
  for (const pid of [sshdPid, sshd2Pid]) {
    if (pid !== null && pid > 1) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  if (root) cleanup(root);
}, 20_000);

async function runSnapshot(p: number, command: string, overrides: Partial<SshConnectionSnapshotWire> = {}) {
  const dir = join(root, `run-${p}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config");
  const snap = snapshotFor(p, overrides);
  writeFileSync(configPath, renderSshConfigContents(snap), { mode: 0o600 });
  const argv = buildSshInvocation({ sshBin, snapshot: snap, configPath, remoteCommand: remoteCommandLine(command, null) });
  const env = await sshChildEnv(snap, home); // HOME has NO .ssh: only -F and the argv exist
  return await runSshProcess(argv, env, 15_000);
}

describe("real isolated sshd", () => {
  const test = HAVE_SSH ? it : it.skip;

  test("a benign run through the rendered config executes on the destination", async () => {
    const res = await runSnapshot(port, "echo subshell-fixture-ok");
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("subshell-fixture-ok");
    expect(res.code).toBe(0);
  }, 30_000);

  test("unknown host key fails closed and classifies host_key_unknown", async () => {
    const res = await runSnapshot(port, "echo nope", { knownHostsFiles: [] });
    expect(res.code).toBe(255);
    expect(res.stdout).not.toContain("nope");
    expect(classifySshFailure(res.stderr)).toBe("host_key_unknown");
  }, 30_000);

  test("changed host key fails closed, never re-trusts, and classifies host_key_changed", async () => {
    const wrong = join(root, "known_hosts_wrong");
    Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(root, "wrongkey")]);
    const wrongBlob = readFileSync(join(root, "wrongkey.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
    writeFileSync(wrong, `[127.0.0.1]:${port} ${wrongBlob}\n`);
    const res = await runSnapshot(port, "echo pwned", { knownHostsFiles: [wrong] });
    expect(res.code).toBe(255);
    expect(res.stdout).not.toContain("pwned");
    expect(res.stderr).toContain("REMOTE HOST IDENTIFICATION HAS CHANGED");
    expect(classifySshFailure(res.stderr)).toBe("host_key_changed");
  }, 30_000);

  test("the supervisor engine runs one real command end to end (capture, status, read)", async () => {
    const dataDir = join(root, "sup-data");
    mkdirSync(dataDir, { recursive: true });
    const sup = new SshRunSupervisor({ dataDir, homeDir: home, sshBin });
    const req = {
      runId: makeRunId(900),
      requestDigest: makeDigest("sshd-run"),
      snapshot: snapshotFor(port),
      remoteDir: null,
      command: "echo out-here && echo err-here 1>&2 && exit 3",
      deadlineMs: 20_000,
    };
    const started = await sup.start(req);
    expect(started.kind).toBe("facts");
    for (let i = 0; i < 200; i++) {
      const s = sup.status(req.runId);
      if (s?.lifecycle === "completed") break;
      await Bun.sleep(100);
    }
    const facts = sup.status(req.runId);
    expect(facts?.lifecycle).toBe("completed");
    expect(facts?.remoteStatus).toBe(3);
    expect(facts?.remoteStatusConfirmed).toBe(true);
    const read = await sup.read(req.runId, 0, 0, 4096, 0);
    expect(Buffer.from(read!.stdoutB64, "base64").toString()).toContain("out-here");
    expect(Buffer.from(read!.stderrB64, "base64").toString()).toContain("err-here");
  }, 40_000);

  test("ProxyJump: the -F policy file is what the JUMP child authenticates against (no ambient HOME config exists)", async () => {
    // Destination is sshd #2; hop is sshd #1. The child ssh the jump spawns
    // gets only what the PARENT's -F file and the propagated options give it:
    // the fixture HOME has no `.ssh`, and hop trust lives ONLY in the -F
    // file's UserKnownHostsFile entry. Success therefore proves §2's
    // "normalize every hop under the same restrictions" actually reaches the
    // hop; failure would prove the renderer cannot rely on -F and must
    // compose the jump chain explicitly instead.
    const dir = join(root, "jump");
    mkdirSync(dir, { recursive: true });
    const snap = snapshotFor(port2, { proxyJumps: [{ host: "127.0.0.1", user: account, port }], knownHostsFiles: [knownHosts2] });
    const configPath = join(dir, "config");
    writeFileSync(configPath, renderSshConfigContents(snap), { mode: 0o600 });
    const argv = buildSshInvocation({
      sshBin,
      snapshot: snap,
      configPath,
      remoteCommand: remoteCommandLine("echo via-hop", null),
    });
    const env = await sshChildEnv(snap, home);
    const res = await runSshProcess(argv, env, 20_000);
    expect(res.stdout).toContain("via-hop");
    expect(res.code).toBe(0);
  }, 60_000);
});
