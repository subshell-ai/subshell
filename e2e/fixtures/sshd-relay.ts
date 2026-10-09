/**
 * The relay crown-jewel fixture (spec 2026-10-08 §13, e2e spec 23): the M1
 * sshd daemon extended to the M2 three-machine shape, all on this one host as
 * this one OS user, but each machine with its OWN home:
 *
 *  - **D**, the destination: a real sshd on a loopback ephemeral port whose
 *    `authorized_keys` trusts ONLY A's client key. B holds nothing D accepts.
 *  - **A**, the key home: a home whose `.ssh/known_hosts` pre-pins D's host
 *    key (the `ssh_host_key` capture source), and whose REAL ssh-agent (spawned
 *    by the spec, OpenSSH 10.x on this fleet) holds A's private keys. A's node
 *    agent runs with `HOME=<homeA>` and `SSH_AUTH_SOCK=<the real agent>`.
 *  - **B**, the connecting machine: a home whose `.ssh/config` resolves the
 *    destination aliases, with NO keys and NO agent socket anywhere near it.
 *    B's pane authenticates through the relay proxy socket and nothing else.
 *
 * The homes are plain files under the caller's temp root; nothing touches the
 * developer's `~/.ssh`. The second (hang) port exists for the grant-revoke
 * leg: a listener that accepts and never speaks, so a pane's `ssh` sits in
 * the banner wait — the relay stays open, no signature ever reaches D, and
 * the revoke lands BETWEEN the relay handshake and D with nothing racy about
 * the timing.
 *
 * `rotateHostKey` stands up a changed-D-host-key world: new host key, same
 * port, same config, fresh daemon. The TOFU leg of the spec needs exactly
 * that, and needs A's known_hosts line for it (the fresh-capture bytes).
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import path from "node:path";
import { SSH_FIXTURE_ALIAS, type SshFixture, startSshFixture, which } from "./sshd.js";

/** The alias on B that dials the hang listener (the revoke window's destination). */
export const RELAY_HANG_ALIAS = "e2erelayhang";

/** Where the sshd fixture lives plus everything the relay spec needs around it. */
export interface RelayFixture {
  /** The M1 sshd fixture (D): its own surface (logPath, deadPort, stop). */
  d: SshFixture;
  /** The port the destination sshd (D) answers on. */
  port: number;
  /** sshd's own VERBOSE log (a real "Accepted publickey" line is a connect truth). */
  logPath: string;
  /** The port of the never-answers listener (the revoke window's "D"). */
  hangPort: number;
  /** The fixture account (the sshd user). */
  user: string;
  /** Machine A's HOME: `.ssh/known_hosts` pre-trusts D (both ports). */
  homeA: string;
  /** Machine B's HOME: `.ssh/config` resolves the aliases; no keys, ever. */
  homeB: string;
  /** A's GRANTED client key (private half; the spec ssh-adds it). */
  keyA: string;
  /** A's UNGRANTED client key (private half; in the agent, outside every grant). */
  keyA2: string;
  /** The agent comment that rides with keyA's identity (distinct by construction). */
  keyAComment: string;
  /** The agent comment that rides with keyA2's identity. */
  keyA2Comment: string;
  /** The `known_hosts` line A currently records for D at D's port (the pin source). */
  knownHostsLineD(): string;
  /** Replace A's recorded line for D's port (the TOFU re-trust the operator's `ssh` would write). */
  setKnownHostsLineD(line: string): void;
  /** Change D's host identity: fresh key, same port, restarted daemon; returns the new A-side line. */
  rotateHostKey(): Promise<{ knownHostsLine: string }>;
  stop(): Promise<void>;
}

/**
 * Start the three-machine fixture under `root`. The `setEnv` map becomes
 * sshd `SetEnv` lines on D: the "Set up Subshell here" leg sends its session
 * env at scratch paths (config home, install data dir, no service) so the
 * installer's ACT is real but every byte it writes lands under the temp root,
 * never the developer's home.
 */
export async function startRelayFixture(
  root: string,
  options: { setEnv?: Record<string, string> } = {},
): Promise<RelayFixture> {
  const d = await startSshFixture(root, { envPath: undefined, setEnv: options.setEnv });
  const user = d.user;

  // The rotated daemon's pid (null until rotateHostKey runs; stop() reaps it).
  let rotatedPid: number | null = null;

  // The hang listener: accepts, holds, never speaks. ssh stalls reading the
  // version banner; the child lives until the relay's own lifetime cap.
  const hangSockets = new Set<Socket>();
  const hang = createServer((sock) => {
    hangSockets.add(sock);
    sock.on("data", () => {
      /* ssh may send after a banner timeout; the silence is the point */
    });
    sock.on("close", () => hangSockets.delete(sock));
    sock.on("error", () => hangSockets.delete(sock));
  });
  await new Promise<void>((resolve, reject) => {
    hang.once("error", reject);
    hang.listen(0, "127.0.0.1", () => resolve());
  });
  const hangPort = (hang.address() as { port: number }).port;

  // A's key + a second key that stays OUTSIDE every grant (the fingerprint
  // scope's negative case and the roster's plurality check). The -C comments
  // are DISTINCT ON PURPOSE: the agent carries them through to the roster, so
  // the spec can tell the two identities apart without touching key material
  // (the ssh-keygen default comment is user@host - identical for both keys).
  const keyA = path.join(root, "keyA");
  const keyA2 = path.join(root, "keyA2");
  const KEY_A_COMMENT = "relay-granted";
  const KEY_A2_COMMENT = "relay-ungranted";
  for (const [f, comment] of [
    [keyA, KEY_A_COMMENT],
    [keyA2, KEY_A2_COMMENT],
  ] as const) {
    const kg = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", f], { stdio: "ignore" });
    if (kg.status !== 0) throw new Error(`ssh-keygen failed for ${f}: exit ${kg.status}`);
  }
  // D trusts exactly A's granted key. The ungranted one is NOT authorized: a
  // sign request for it must die at the responder, and even a smuggled one
  // could never authenticate.
  writeFileSync(path.join(root, "authorized_keys"), `${readFileSync(`${keyA}.pub`, "utf8").trim()}\n`);

  // Machine A's home: the trust file the pin capture reads. Both destinations
  // (D and the hang port) carry D's current host key: the hang leg never
  // reaches a host-key check, but its pin capture demands a known_hosts entry.
  const homeA = path.join(root, "homeA");
  mkdirSync(path.join(homeA, ".ssh"), { recursive: true, mode: 0o700 });
  const keyTypeAndBlob = (): string =>
    readFileSync(path.join(root, "hostkey.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
  const lineFor = (port: number): string => `[127.0.0.1]:${port} ${keyTypeAndBlob()}`;
  const aKnownHosts = path.join(homeA, ".ssh", "known_hosts");
  const writeAKnownHosts = (lineD: string): void => {
    writeFileSync(aKnownHosts, `${lineD}\n${lineFor(hangPort)}\n`);
  };
  writeAKnownHosts(lineFor(d.port));

  // Machine B's home: aliases only. No keys, no known_hosts (the relay pins
  // the trust file itself; B's ambient trust must not matter, and asserting
  // its absence is part of "B holds none").
  const homeB = path.join(root, "homeB");
  mkdirSync(path.join(homeB, ".ssh"), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(homeB, ".ssh", "config"),
    [
      `Host ${SSH_FIXTURE_ALIAS}`,
      "    HostName 127.0.0.1",
      `    Port ${d.port}`,
      `    User ${user}`,
      `Host ${RELAY_HANG_ALIAS}`,
      "    HostName 127.0.0.1",
      `    Port ${hangPort}`,
      `    User ${user}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  return {
    d,
    port: d.port,
    logPath: d.logPath,
    hangPort,
    user,
    homeA,
    homeB,
    keyA,
    keyA2,
    keyAComment: KEY_A_COMMENT,
    keyA2Comment: KEY_A2_COMMENT,
    knownHostsLineD: () => lineFor(d.port),
    setKnownHostsLineD: (line: string) => writeAKnownHosts(line),
    async rotateHostKey(): Promise<{ knownHostsLine: string }> {
      await d.stop();
      if (rotatedPid !== null) {
        // Two rotations in one run (the suite never asks for one, but the
        // shape is cheap): the previous rotated daemon must die first.
        try {
          process.kill(rotatedPid, "SIGKILL");
        } catch {
          /* already gone */
        }
        rotatedPid = null;
      }
      // The fixture's sshd_config names `<root>/hostkey`; ssh-keygen refuses
      // to overwrite in place, so the name goes first.
      rmSync(path.join(root, "hostkey"), { force: true });
      rmSync(path.join(root, "hostkey.pub"), { force: true });
      const kg = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, "hostkey")], {
        stdio: "ignore",
      });
      if (kg.status !== 0) throw new Error(`rotate hostkey failed: exit ${kg.status}`);
      const sshdBin = which("sshd", ["/usr/sbin/sshd"]);
      if (sshdBin === null) throw new Error("rotate: sshd binary vanished mid-run");
      const sshdDir = path.join(root, "sshd");
      const logFd = openSync(path.join(sshdDir, "sshd.log"), "a");
      const child = spawn(sshdBin, ["-D", "-f", path.join(sshdDir, "sshd_config"), "-e"], {
        stdio: ["ignore", "ignore", logFd],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      closeSync(logFd);
      rotatedPid = child.pid ?? null;
      // Readiness: same "not refused" rule, through ssh, ambient-config free.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const probe = spawnSync(
          "ssh",
          [
            "-F",
            "/dev/null",
            "-p",
            String(d.port),
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
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        const err = probe.stderr?.toString() ?? "";
        if (!/Connection refused|connect to host 127\.0\.0\.1 port|Connection timed out/i.test(err)) break;
        if (Date.now() > deadline) throw new Error(`rotated sshd did not come back on port ${d.port}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      return { knownHostsLine: lineFor(d.port) };
    },
    async stop(): Promise<void> {
      for (const sock of hangSockets) {
        try {
          sock.destroy();
        } catch {
          /* already gone */
        }
      }
      await new Promise<void>((resolve) => hang.close(() => resolve()));
      if (rotatedPid !== null) {
        try {
          process.kill(rotatedPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await d.stop();
    },
  };
}
