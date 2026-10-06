/**
 * The e2e sshd fixture (spec 21): a REAL isolated sshd, the port of
 * `packages/pane-runtime/src/ssh/__tests__/sshd-fixture.test.ts`'s recipe
 * from Bun APIs to Node ones (the Playwright runner is Node). It owns and
 * cleans only its own pieces: generated host + client keys, one sshd on a
 * loopback ephemeral port (own pid tracked), and an `sshConfigHome` the node
 * agent runs as its HOME. The developer's `~/.ssh` is never touched — every
 * byte lives under the caller's temp root.
 *
 * Trust choice (one pick, documented per the brief): a PRE-TRUSTED
 * `known_hosts` at `<sshConfigHome>/.ssh/known_hosts` — exactly where the
 * node's `ssh -G` resolves the default `UserKnownHostsFile` (the child HOME
 * is this dir), so the approved snapshot carries the fixture's trusted file
 * and the runtime's mandatory `StrictHostKeyChecking yes` passes on the
 * pinned key. No `accept-new` first-contact pinning: the feature requires
 * existing verified trust, and the fixture enters that contract already
 * trusted rather than exercising a mode production never uses.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import path from "node:path";

/** The alias every consumer of this fixture references (`~/.ssh/config`). */
export const SSH_FIXTURE_ALIAS = "e2edest";

/** sshd's known install locations beyond PATH (probe fallbacks, the ladder's shape). */
const SSHD_KNOWN_PATHS = ["/usr/sbin/sshd"];

/** PATH probe (the Node stand-in for `Bun.which`); sshd also checks the known install paths and honors `E2E_SSHD_BIN`. */
function which(bin: string, extraPaths: readonly string[] = []): string | null {
  const override = bin === "sshd" ? process.env["E2E_SSHD_BIN"] : undefined;
  if (override !== undefined && override !== "") return override;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "");
  for (const dir of [...dirs, ...extraPaths]) {
    try {
      accessSync(path.join(dir, bin));
      return path.join(dir, bin);
    } catch {
      // not here
    }
  }
  return null;
}

/** The missing pieces, empty when the host can run the real-daemon suite. */
export function missingSshBins(): string[] {
  const missing: string[] = [];
  if (which("ssh") === null) missing.push("ssh");
  if (which("ssh-keygen") === null) missing.push("ssh-keygen");
  if (which("sshd", SSHD_KNOWN_PATHS) === null) missing.push("sshd");
  return missing;
}

/** A loopback ephemeral port, freed the instant it is named (the Node stand-in for `Bun.listen`). */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** The probe asks "is anything listening"; StrictHostKeyChecking=no is the probe's own trust, never the feature's (the real trust is the pre-trusted known_hosts). `-F /dev/null` seals the ambient `~/.ssh/config` out of a probe meant to be ambient-free. */
const PROBE_OPTS = [
  "BatchMode=yes",
  "ConnectTimeout=1",
  "StrictHostKeyChecking=no",
  "UserKnownHostsFile=/dev/null",
].flatMap((o) => ["-o", o]);

/** sshd's readiness, probed through ssh itself: "not refused" means the daemon answers (the bun recipe's rule). */
async function waitListening(sshBin: string, port: number, logPath: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const probe = spawnSync(sshBin, ["-F", "/dev/null", "-p", String(port), ...PROBE_OPTS, "127.0.0.1", "true"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const err = probe.stderr?.toString() ?? "";
    if (!/Connection refused|connect to host 127\.0\.0\.1 port|Connection timed out/i.test(err)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`sshd did not come up on 127.0.0.1:${port}\n${readFileSync(logPath, "utf8").slice(-2000)}`);
}

export interface SshFixture {
  /** The loopback port the fixture sshd answers on. */
  port: number;
  /** A loopback port THIS fixture holds with an accept-then-destroy listener: the dead-run target answers with an immediate connection reset (a freed port could be silently rebound between free and dial, turning the honest 255 into a ssh-connect timeout). */
  deadPort: number;
  /** The fixture user — the host's own account (sshd refuses passwords; keys only). */
  user: string;
  /** The directory to hand the node agent as HOME (its `.ssh/` carries config + known_hosts). */
  sshConfigHome: string;
  /** Absolute path of the passphrase-less client key sshd authorizes. */
  trustedKeyPath: string;
  /** The daemon's own stderr log — a real "Accepted publickey" line is a connect truth no client-side fact gives. */
  logPath: string;
  /** SIGTERM the daemon this fixture started (and only that one). */
  stop(): Promise<void>;
}

/** Live fixture daemons, killed on process exit so a crashed worker never strands an sshd. */
const live = new Set<number>();
process.on("exit", () => {
  for (const pid of live) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

/**
 * Start the fixture under `root` (a caller-mkdtemp'd dir; the caller owns the
 * bytes, this function owns the daemon). Generates ed25519 host + client keys,
 * writes the account config alias `e2edest`, the pre-trusted `known_hosts`,
 * and sshd's own config (loopback-only, key-only auth, no PAM).
 *
 * `envPath` (spec 23) adds one `SetEnv PATH=` line. sshd resets a session's
 * PATH to the platform login default regardless of the daemon's own
 * environment (measured: a PATH prepended before spawn never reaches the
 * remote command), so a destination that must find a scratch binary on PATH
 * needs the daemon to hand it out. Absent, the fixture is exactly the
 * default-PATH world it has always been.
 */
export async function startSshFixture(root: string, options: { envPath?: string } = {}): Promise<SshFixture> {
  const sshBin = which("ssh");
  const keygenBin = which("ssh-keygen");
  const sshdBin = which("sshd", SSHD_KNOWN_PATHS);
  if (sshBin === null || keygenBin === null || sshdBin === null) {
    throw new Error(`startSshFixture called on a host without ssh/ssh-keygen/sshd (${missingSshBins().join(", ")})`);
  }
  // The connecting account NAME, deterministically. `os.userInfo().username`
  // is env-driven on bun (the Playwright runner IS bun) and passwd-driven on
  // node: in a container with no USER/LOGNAME env bun answers "unknown" while
  // sshd, matching the uid not the env, logs the real account ("root").
  // uid 0 is root on every supported OS; otherwise env, then the passwd
  // lookup. The spec also hands the agent `USER`/`LOGNAME` (see 21-ssh) so
  // the daemon's own `connectingAccount` says the same thing everywhere.
  const user = process.getuid?.() === 0 ? "root" : (process.env.USER ?? process.env.LOGNAME ?? userInfo().username);
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(home, ".ssh"), { mode: 0o700 });
  chmodSync(home, 0o700);

  const hostKey = path.join(root, "hostkey");
  const clientKey = path.join(root, "clientkey");
  for (const f of [hostKey, clientKey]) {
    const kg = spawnSync(keygenBin, ["-q", "-t", "ed25519", "-N", "", "-f", f], { stdio: "ignore" });
    if (kg.status !== 0) throw new Error(`ssh-keygen failed for ${f}: exit ${kg.status}`);
  }

  const port = await freePort();
  // The dead-run target, HELD for the fixture's life (review M2): we bind the
  // named-free port ourselves and destroy every inbound socket, so a dial is
  // refused fast (ssh: "Connection closed", exit 255 - exactly what
  // sshTransportFailure corroborates) and NO third party can re-bind the name
  // between our freePort and the dead run's connect.
  const deadPort = await freePort();
  const refuseHold = createServer((sock) => sock.destroy());
  await new Promise<void>((resolve, reject) => {
    refuseHold.once("error", reject);
    refuseHold.listen(deadPort, "127.0.0.1", () => resolve());
  });

  // Pre-trusted known_hosts, named ABSOLUTE in the config below. ssh resolves
  // the DEFAULT `userknownhostsfile` against the passwd home, not the injected
  // $HOME, so a bare `~/.ssh/known_hosts` default would make the approved
  // snapshot point at the host user's real file and the mandatory
  // `StrictHostKeyChecking yes` probe fail host_key_unknown. The bracketed
  // `[host]:port` authority form is what the non-22 port matches.
  const knownHosts = path.join(home, ".ssh", "known_hosts");
  const keyTypeAndBlob = readFileSync(`${hostKey}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  writeFileSync(knownHosts, `[127.0.0.1]:${port} ${keyTypeAndBlob}\n`);

  // The account's config: the alias every consumer references. `IdentityAgent
  // none` keeps an ambient ssh-agent out of resolution (its keys could crowd
  // the fixture's single trusted key against sshd's MaxAuthTries).
  writeFileSync(
    path.join(home, ".ssh", "config"),
    [
      `Host ${SSH_FIXTURE_ALIAS}`,
      "    HostName 127.0.0.1",
      `    Port ${port}`,
      `    User ${user}`,
      `    IdentityFile ${clientKey}`,
      "    IdentitiesOnly yes",
      "    IdentityAgent none",
      `    UserKnownHostsFile ${knownHosts}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  // sshd trusts exactly the fixture's client key; the host's own `~/.ssh` is
  // never consulted (StrictModes off lets authorized_keys live at the root).
  const authorizedKeys = path.join(root, "authorized_keys");
  writeFileSync(authorizedKeys, `${readFileSync(`${clientKey}.pub`, "utf8").trim()}\n`);

  const sshdDir = path.join(root, "sshd");
  mkdirSync(sshdDir, { recursive: true });
  const sshdConfig = path.join(sshdDir, "sshd_config");
  const sshdLog = path.join(sshdDir, "sshd.log");
  writeFileSync(
    sshdConfig,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      "AddressFamily inet",
      `HostKey ${hostKey}`,
      `PidFile ${path.join(sshdDir, "sshd.pid")}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      "StrictModes no",
      "UsePAM no",
      "UseDNS no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitUserEnvironment no",
      "PrintMotd no",
      "LogLevel VERBOSE",
      // The spec-23 seam: a session PATH the daemon hands out (the default
      // login PATH would otherwise hide any scratch binary). One token, no
      // spaces: sshd's SetEnv value grammar.
      ...(options.envPath !== undefined && options.envPath !== "" ? [`SetEnv PATH=${options.envPath}`] : []),
    ].join("\n"),
  );
  // sshd's privilege-separation directory is compiled in (/run/sshd; no
  // sshd_config keyword overrides it) and the daemon refuses to start without
  // it. Measured: the CI builder image's openssh-server postinst does NOT
  // create it in a non-systemd container (job run 37274033881 died exactly
  // there), while dev hosts usually have one because sshd is installed and
  // running. Ensure it opportunistically: an existing dir or a non-writable
  // /run surfaces through sshd's own stderr in the readiness failure below.
  try {
    mkdirSync("/run/sshd", { mode: 0o755 });
  } catch {
    // already there, or not ours to make - sshd's log will say which
  }
  // sshd -e means "log to stderr" and takes NO file argument: the fixture
  // redirects the child's stderr into its own file (the bun recipe's rule).
  const logFd = openSync(sshdLog, "w");
  const child = spawn(sshdBin, ["-D", "-f", sshdConfig, "-e"], {
    stdio: ["ignore", "ignore", logFd],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  closeSync(logFd);
  const pid = child.pid;
  if (pid === undefined) throw new Error("sshd spawn returned no pid");
  live.add(pid);
  child.once("exit", () => live.delete(pid));
  // A spawn-adjacent failure is async on a long-lived child: hold the message
  // for the readiness failure text rather than letting it throw unhandled.
  let spawnError: string | null = null;
  child.once("error", (err) => {
    spawnError = String(err);
  });
  try {
    await waitListening(sshBin, port, sshdLog);
  } catch (err) {
    throw new Error(`${String(err)}${spawnError === null ? "" : `\nspawn error: ${spawnError}`}`);
  }

  return {
    port,
    deadPort,
    user,
    sshConfigHome: home,
    trustedKeyPath: clientKey,
    logPath: sshdLog,
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => refuseHold.close(() => resolve()));
      live.delete(pid);
      for (const sig of ["SIGTERM", "SIGKILL"] as const) {
        try {
          process.kill(pid, sig);
        } catch {
          return;
        }
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    },
  };
}
