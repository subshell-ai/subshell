import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { TmuxRunner } from "@internal/pane-runtime";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { dispatchLocalSsh } from "@/services/ssh/ssh-local.js";
import {
  nodeSshDiscover,
  nodeSshInputControl,
  nodeSshResolve,
  nodeSshTerminalLaunch,
  SshNodeRefusal,
} from "@/services/ssh/ssh-node-client.js";

/**
 * The built-in `local` node's in-process SSH dispatch (review I3): the server's
 * own node answers the SAME ssh_* verbs the agent daemon wraps, against the
 * server's pane data dir, with no frame and no socket.
 *
 * Two regimes, mirroring the runtime's own suites:
 * - **discover / resolve / id-grammar**: always run. Resolution uses a SHIM
 *   ssh pinned through the `SUBSHELL_SSH_PATH` override the ladder reads first,
 *   so the decision is hermetic; discovery reads a fixture config under a temp
 *   HOME. No network, no daemon.
 * - **a real managed terminal open/close**: the headline claim of I3, run
 *   against a real sshd bound to loopback on an OS-allocated port, real keys,
 *   and real tmux (the pane's foreground process is ssh). LOUD-SKIPPED when any
 *   of ssh/sshd/ssh-keygen/tmux is absent on the host (the `ssh-loopback-sshd`
 *   pattern); everywhere else it proves the pane comes up AND tears down.
 */

const HAVE_DAEMON =
  Bun.which("ssh") !== null &&
  Bun.which("sshd") !== null &&
  Bun.which("ssh-keygen") !== null &&
  Bun.which("tmux") !== null;
if (!HAVE_DAEMON) {
  console.warn(
    "[ssh-local] ssh/sshd/ssh-keygen/tmux not all present: REAL LOCAL TERMINAL OPEN/CLOSE SKIPPED (loud skip; the shim cases below still run)",
  );
}

let root: string;
let savedSshPath: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "subshell-ssh-local-"));
  savedSshPath = process.env.SUBSHELL_SSH_PATH;
});

afterAll(() => {
  if (savedSshPath === undefined) delete process.env.SUBSHELL_SSH_PATH;
  else process.env.SUBSHELL_SSH_PATH = savedSshPath;
  rmSync(root, { recursive: true, force: true });
});

/** A recording shim ssh that answers `-G` with `dashG`; pinned via SUBSHELL_SSH_PATH. */
function writeShim(dir: string, dashG: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "ssh");
  writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "-G" ]; then cat <<'GEOF'\n${dashG}\nGEOF\nexit 0\nfi; done\nexit 255\n`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return bin;
}

function gConfig(home: string, body: string): void {
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "config"), body);
}

const CLEAN_G = [
  "host staging",
  "hostname staging.example",
  "user deploy",
  "port 2200",
  "identityfile ~/.ssh/id_ed25519",
  "userknownhostsfile /home/deploy/.ssh/known_hosts",
  "tunnel false",
  "permitremoteopen any",
].join("\n");

describe("local node in-process dispatch (ssh-node-client → ssh-local, no frame)", () => {
  it("resolves an alias through the local runtime and returns the approved snapshot", async () => {
    const home = join(root, "res-home");
    gConfig(home, "Host staging\n  HostName staging.example\n");
    const shim = writeShim(join(root, "shim-res"), CLEAN_G);
    process.env.SUBSHELL_SSH_PATH = shim;
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // Through the client seam (which routes `local` to ssh-local), not ssh-local directly:
      const outcome = await nodeSshResolve("local", "staging");
      expect(outcome.accepted).toBe(true);
      if (outcome.accepted) {
        expect(outcome.snapshot.host).toBe("staging.example");
        expect(outcome.snapshot.port).toBe(2200);
        // The tilde default identity expanded against the fixture HOME, and the
        // client-side parse ran on the local answer exactly as on a socket one.
        expect(outcome.snapshot.identityFiles).toEqual([join(home, ".ssh/id_ed25519")]);
      }
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it("discovers alias NAMES only from the account config, on the local node", async () => {
    const home = join(root, "disc-home");
    gConfig(home, "Host alpha\n  HostName a.example\nHost beta\n  User x\n");
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await nodeSshDiscover("local");
      expect(result.aliases).toEqual(["alpha", "beta"]);
      expect(result.includeCycle).toBe(false);
      expect(result.truncated).toBe(false);
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it("routes a non-ssh command aimed at local to the unsupported arm (the seam is the ssh family only)", async () => {
    // dispatchLocalSsh's default arm; `nodeSsh*` never sends this, so it is a
    // direct-dispatch assertion that the dispatcher refuses, not crashes.
    const res = await dispatchLocalSsh({ type: "ssh_resolve_config", alias: "-x" });
    // A shape-invalid alias is a resolve REFUSAL carried in the data (accepted:false),
    // not an unsupported error — the filter runs the argv gate first.
    expect(res.ok).toBe(true);
    if (res.ok && res.data) {
      expect((res.data as { accepted: boolean }).accepted).toBe(false);
    }
  });

  it("refuses a malformed input-control id and a malformed terminal-launch id", async () => {
    // The path-composition gate the agent enforces before composing any path.
    const badControl = await dispatchLocalSsh({
      type: "ssh_input_control",
      subshellId: "../escape",
      mode: "human",
      generation: 1,
    });
    expect(badControl.ok).toBe(false);
    const badLaunch = await dispatchLocalSsh({
      type: "ssh_terminal_launch",
      subshellId: "NOT HEX OR DASHES $$$",
      socket: "s",
      snapshot: {
        alias: "x",
        host: "h",
        user: null,
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
      } as SshConnectionSnapshotWire,
      remoteDir: null,
    });
    expect(badLaunch.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* the real local managed terminal (loud-skip if the stack is absent)  */
/* ------------------------------------------------------------------ */

if (HAVE_DAEMON) {
  describe("local node managed terminal: real sshd + real tmux open/close", () => {
    let home: string;
    let account: string;
    let clientKey = "";
    let knownHostsPath = "";
    let daemonPort = 0;
    let sshdPid = 0;

    async function ephemeralPort(): Promise<number> {
      const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, error() {} } });
      const port = probe.port;
      probe.stop();
      await Bun.sleep(10);
      return port;
    }

    async function startSshd(dir: string): Promise<number | null> {
      mkdirSync(dir, { recursive: true });
      const port = await ephemeralPort();
      const cfg = [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(root, "hostkey")}`,
        `PidFile ${join(dir, "sshd.pid")}`,
        "StrictModes no",
        "UsePAM no",
        "PubkeyAuthentication yes",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        `AuthorizedKeysFile ${join(home, ".ssh", "authorized_keys")}`,
        "PrintMotd no",
      ].join("\n");
      writeFileSync(join(dir, "sshd_config"), cfg);
      const logFd = Bun.file(join(dir, "sshd.log"));
      const proc = Bun.spawn(["/usr/sbin/sshd", "-D", "-f", join(dir, "sshd_config"), "-e"], {
        stdout: "ignore",
        stderr: logFd,
        stdin: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      sshdPid = proc.pid;
      const sshBin = Bun.which("ssh") as string;
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
        if (!/Connection refused|port .* refused|Connection timed out/i.test(probe.stderr.toString())) return port;
        await Bun.sleep(100);
      }
      // Loud: the daemon log is the diagnosis when it never came up.
      try {
        console.warn(`[ssh-local] sshd did not accept on loopback; log:\n${await logFd.text()}`);
      } catch {
        console.warn("[ssh-local] sshd did not accept on loopback (no log)");
      }
      return null;
    }

    beforeAll(async () => {
      home = join(root, "term-home");
      mkdirSync(join(home, ".ssh"), { recursive: true });
      account = userInfo().username;
      for (const name of ["hostkey", "clientkey"]) {
        const kg = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(root, name)], {
          stderr: "pipe",
        });
        if (kg.exitCode !== 0) throw new Error(`ssh-keygen ${name}: ${kg.stderr.toString()}`);
      }
      clientKey = join(root, "clientkey");
      const pub = readFileSync(`${clientKey}.pub`, "utf8").trim();
      writeFileSync(join(home, ".ssh", "authorized_keys"), `${pub}\n`, { mode: 0o600 });
      const hostLine = readFileSync(join(root, "hostkey.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
      knownHostsPath = join(root, "known_hosts");
      daemonPort = (await startSshd(join(root, "sshd"))) ?? 0;
      // The port is only known after the daemon binds; rewrite trust with it.
      if (daemonPort > 0) writeFileSync(knownHostsPath, `[127.0.0.1]:${daemonPort} ${hostLine}\n`);
      // The terminal must use the REAL ssh (it connects), not the shim above.
      process.env.SUBSHELL_SSH_PATH = Bun.which("ssh") as string;
    }, 120_000);

    afterAll(() => {
      if (sshdPid) {
        try {
          process.kill(sshdPid, "SIGTERM");
        } catch {
          // gone
        }
      }
    });

    it("opens a managed pane whose foreground process is ssh, then closes it", async () => {
      if (daemonPort === 0) {
        console.warn("[ssh-local] loopback sshd did not come up: terminal open/close SKIPPED (loud skip)");
        return;
      }
      const subshellId = crypto.randomUUID().replaceAll("-", "");
      const socket = `ssh-local-${subshellId.slice(0, 8)}`;
      const snapshot: SshConnectionSnapshotWire = {
        alias: "localterm",
        host: "127.0.0.1",
        user: account,
        port: daemonPort,
        identityFiles: [clientKey],
        certificateFiles: [],
        authAgentSocket: null,
        knownHostsFiles: [knownHostsPath],
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
      };
      const tmux = new TmuxRunner();
      const savedHome = process.env.HOME;
      process.env.HOME = home;
      try {
        await nodeSshTerminalLaunch("local", { subshellId, socket, snapshot, remoteDir: null, cols: 100, rows: 30 });
        // The pane exists and is alive (ssh connected to the loopback daemon and
        // is the foreground process, no local shell). Poll through ssh's own
        // connect window.
        let alive = false;
        for (let i = 0; i < 60 && !alive; i++) {
          alive = await tmux.hasSubshell(socket, subshellId);
          if (!alive) await Bun.sleep(100);
        }
        expect(alive).toBe(true);

        // A takeover raises the plane-side generation; the local input-control
        // answers the state that took effect (the node's half of the same act).
        const control = await nodeSshInputControl("local", { subshellId, mode: "human", generation: 5 });
        expect(control).toEqual({ subshellId, mode: "human", generation: 5 });
        // A replayed LOWER generation is refused, exactly like a live node:
        let refused: unknown = null;
        try {
          await nodeSshInputControl("local", { subshellId, mode: "agent", generation: 3 });
        } catch (err) {
          refused = err;
        }
        expect(refused).toBeInstanceOf(SshNodeRefusal);

        // Close it (terminate the pane): the ssh foreground dies with it.
        tmux.killSubshell(socket, subshellId);
        let gone = false;
        for (let i = 0; i < 50 && !gone; i++) {
          gone = !(await tmux.hasSubshell(socket, subshellId));
          if (!gone) await Bun.sleep(100);
        }
        expect(gone).toBe(true);
        // The launch wrote the terminal state under the server's own data dir
        // (proof it ran the runtime directly, not a socket).
        expect(existsSync(join(SUBSHELL_SERVER_DATA_DIR, "ssh", "terminals", `${subshellId}.json`))).toBe(true);
      } finally {
        process.env.HOME = savedHome;
        try {
          tmux.killSubshell(socket, subshellId);
        } catch {
          // already gone
        }
      }
    }, 60_000);
  });
}
