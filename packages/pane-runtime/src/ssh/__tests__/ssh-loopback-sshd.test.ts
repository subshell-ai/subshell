import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { classifySshFailure } from "../ssh-diagnose.js";
import { buildSshInvocation, remoteCommandLine, renderSshConfigContents, sshChildEnv } from "../ssh-render.js";
import { runSshProcess } from "../ssh-spawn.js";

/**
 * WORKSTREAM G (Wave 2), deliverable 1: the G-owned ISOLATED SSH FIXTURE - a
 * real sshd bound to loopback on an OS-allocated port (the probe binds
 * 127.0.0.1:0, reads the number, and hands it to sshd), a temp HOME, generated
 * keys and trust material under a temp dir this fixture OWNS, tracked pids,
 * and cleanup only of its own resources (SSH-SUPPORT.md §6: "isolated SSH
 * fixture with temporary accounts, keys, trust files, and config... Never use
 * the live instance or a developer's SSH configuration... Bind test services to
 * loopback, track their processes, and clean up only resources the fixture
 * owns"). The fixture HOME carries ONLY the files these lines write - no
 * `.ssh` config a child could read ambiently - and every child runs under
 * `sshChildEnv` with HOME pointed at it. When sshd is absent the suite answers
 * LOUD (console.warn + every case skipped), and the shim-driven suites
 * elsewhere run everywhere.
 *
 * The rows this fixture adds over the existing trust suite (unknown/changed
 * host key, benign run, ProxyJump - covered there) are the certificate half of
 * the §6 "SSH policy" row, which only a real OpenSSH server answers honestly:
 *
 * - **certificate auth works**: a client certificate signed by a CA the
 *   destination trusts authenticates through the FULL rendered path
 *   (IdentityFile + CertificateFile out of the approved snapshot);
 * - **revoked credentials fail closed**: a KRL named under RevokedKeys on a
 *   second daemon refuses the SAME cert+key that just passed the first one -
 *   revocation is honored, not assumed;
 * - **key-only auth is the shipped posture**: against a password-only
 *   destination the BatchMode child fails fast with an actionable named
 *   classification and no interactive prompt, no askpass, no hang (§2's
 *   "passwords... produce actionable instructions" claim, proven on a daemon
 *   that genuinely offers passwords; if this host's sshd cannot come up with
 *   password auth at all, THAT case says so loudly).
 */

const HAVE = Bun.which("ssh") !== null && Bun.which("ssh-keygen") !== null && Bun.which("sshd") !== null;
if (!HAVE) {
  console.warn(
    "[ssh-loopback-fixture] ssh/ssh-keygen/sshd not present: REAL-DAEMON SSH-POLICY TESTS SKIPPED (loud skip, spec §6)",
  );
}

let root: string;
let home: string; // the fixture HOME: NO .ssh config, NO developer material
let sshBin: string;
let account: string;
let clientKey = "";
let clientCert = "";
let knownHosts = "";

/** Free an OS-assigned loopback port the way sshd should get one: bind :0, read it, stop. */
async function ephemeralLoopbackPort(): Promise<number> {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, error() {} } });
  const port = probe.port;
  probe.stop();
  await Bun.sleep(10);
  return port;
}

/** Tracked pids: the fixture kills ONLY what it started (spec §6). */
const pids: number[] = [];

async function startSshd(dir: string, extra: string[]): Promise<{ pid: number; port: number } | null> {
  mkdirSync(dir, { recursive: true });
  const port = await ephemeralLoopbackPort();
  const cfg = [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${join(root, "hostkey")}`,
    `PidFile ${join(dir, "sshd.pid")}`,
    "StrictModes no",
    "UsePAM no",
    "PermitUserEnvironment no",
    "PrintMotd no",
    "LogLevel VERBOSE",
    ...extra,
  ].join("\n");
  writeFileSync(join(dir, "sshd_config"), cfg);
  const logFd = openSync(join(dir, "sshd.log"), "w");
  const proc = Bun.spawn(["/usr/sbin/sshd", "-D", "-f", join(dir, "sshd_config"), "-e"], {
    stdout: "ignore",
    stderr: logFd,
    stdin: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  pids.push(proc.pid);
  // Readiness: KEEP asking the port through ssh itself; "auth refused" already
  // means a daemon is listening (exactly the fact we wait for).
  for (let i = 0; i < 100; i++) {
    const probe = Bun.spawnSync(
      [
        sshBin,
        "-p",
        String(port),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=1",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "127.0.0.1",
        "true",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (!/Connection refused|connect to host 127\.0\.0\.1 port|Connection timed out/i.test(probe.stderr.toString())) {
      return { pid: proc.pid, port };
    }
    await Bun.sleep(100);
  }
  return null;
}

function snapshotFor(port: number, over: Partial<SshConnectionSnapshotWire> = {}): SshConnectionSnapshotWire {
  return {
    alias: "fixture",
    host: "127.0.0.1",
    user: account,
    port,
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
    ...over,
  };
}

/** One run through the FULL local path: render the config, build argv, spawn. */
async function runAgainst(_port: number, snapshot: SshConnectionSnapshotWire, command: string) {
  const dir = mkdtempSync(join(root, "exec-"));
  const configPath = join(dir, "config");
  writeFileSync(configPath, renderSshConfigContents(snapshot), { mode: 0o600 });
  const argv = buildSshInvocation({ sshBin, snapshot, configPath, remoteCommand: remoteCommandLine(command, null) });
  const env = await sshChildEnv(snapshot, home);
  return runSshProcess(argv, env, 15_000);
}

let caDaemonPort = 0; // TrustedUserCAKeys, nothing revoked
let revokedDaemonPort = 0; // TrustedUserCAKeys + RevokedKeys KRL
let pwDaemonPort = 0; // password-only; 0 = this host would not serve it
let pwAvailable = false;

beforeAll(async () => {
  if (!HAVE) return;
  root = mkdtempSync(join(tmpdir(), "subshell-sshd-g-"));
  home = join(root, "home");
  mkdirSync(home);
  account = userInfo().username;
  sshBin = Bun.which("ssh")!;
  chmodSync(root, 0o700);

  for (const name of ["hostkey", "clientkey", "cakey"]) {
    const kg = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(root, name)], {
      stderr: "pipe",
    });
    if (kg.exitCode !== 0) throw new Error(`ssh-keygen ${name} failed: ${kg.stderr.toString()}`);
  }
  clientKey = join(root, "clientkey");
  clientCert = join(root, "clientkey-cert.pub");
  const sign = Bun.spawnSync(
    ["ssh-keygen", "-s", join(root, "cakey"), "-I", "subshell-g", "-n", account, "-V", "+15m", `${clientKey}.pub`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (sign.exitCode !== 0) throw new Error(`cert signing failed: ${sign.stderr.toString()}`);

  const krlPath = join(root, "revoked.krl");
  const krl = Bun.spawnSync(["ssh-keygen", "-k", "-f", krlPath, "-s", join(root, "cakey.pub"), clientCert], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (krl.exitCode !== 0) throw new Error(`KRL build failed: ${krl.stderr.toString()}`);

  const ca = await startSshd(join(root, "sshd-ca"), [
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    `TrustedUserCAKeys ${join(root, "cakey.pub")}`,
  ]);
  if (!ca) throw new Error("CA-trust sshd did not come up on loopback");
  caDaemonPort = ca.port;

  const rev = await startSshd(join(root, "sshd-revoked"), [
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    `TrustedUserCAKeys ${join(root, "cakey.pub")}`,
    `RevokedKeys ${krlPath}`,
  ]);
  if (!rev) throw new Error("revoked-list sshd did not come up on loopback");
  revokedDaemonPort = rev.port;

  const pw = await startSshd(join(root, "sshd-pw"), [
    "PubkeyAuthentication no",
    "PasswordAuthentication yes",
    "KbdInteractiveAuthentication no",
  ]);
  pwAvailable = pw !== null;
  pwDaemonPort = pw?.port ?? 0;
  if (!pwAvailable)
    console.warn(
      "[ssh-loopback-fixture] password-auth sshd did not come up on this host: password-posture case SKIPPED",
    );

  // Trust file: one line per daemon, [host]:port authority exactly as ssh
  // will check it (the fixture's ONLY trust material).
  const hostLine = readFileSync(join(root, "hostkey.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
  knownHosts = join(root, "known_hosts");
  const entries = [caDaemonPort, revokedDaemonPort, ...(pwAvailable ? [pwDaemonPort] : [])];
  writeFileSync(knownHosts, entries.map((p) => `[127.0.0.1]:${p} ${hostLine}\n`).join(""));
}, 120_000);

afterAll(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (root) rmSync(root, { recursive: true, force: true });
}, 20_000);

describe("loopback sshd: certificates, live revocation, key-only posture (spec §6 'SSH policy')", () => {
  const test = HAVE ? it : it.skip;

  test("a CA-signed client certificate authenticates through the rendered path", async () => {
    const res = await runAgainst(
      caDaemonPort,
      snapshotFor(caDaemonPort, { certificateFiles: [clientCert] }),
      "echo cert-auth-ok",
    );
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("cert-auth-ok");
    expect(res.code).toBe(0);
  }, 40_000);

  test("the SAME certificate fails closed on the daemon whose RevokedKeys KRL names it", async () => {
    const res = await runAgainst(
      revokedDaemonPort,
      snapshotFor(revokedDaemonPort, { certificateFiles: [clientCert] }),
      "echo must-not-run",
    );
    expect(res.timedOut).toBe(false);
    expect(res.stdout).not.toContain("must-not-run");
    expect(res.code).toBe(255); // transport/auth refusal, never a remote success
    expect(res.code).not.toBe(0);
  }, 40_000);

  test("a password-only destination fails the BatchMode child fast and NAMED, with no prompt and no hang", async () => {
    if (!pwAvailable) return; // the loud warn fired in setup; the skip is on the record
    const started = Date.now();
    const res = await runAgainst(pwDaemonPort, snapshotFor(pwDaemonPort), "echo never");
    expect(res.stdout).not.toContain("never");
    expect(res.code).toBe(255);
    // The actionable class: §2's "passwords produce actionable instructions"
    // requires the refusal to be NAMEABLE from stderr, and sshd says it.
    expect(classifySshFailure(res.stderr)).toBe("auth_mode_unsupported");
    expect(res.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000); // BatchMode: no interactive wait
  }, 40_000);
});
