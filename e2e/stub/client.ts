import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { BASE_URL } from "../ports";

/**
 * The agent CLI as SOURCE (`bun <root>/apps/client/src/main.ts …`), not the
 * compiled binary — the Phase-3 plan's deviation #1: zero drift with the
 * daemon under test, real crypto, no `bun run compile` gate on the suite.
 * Resolved from `import.meta.url` like `ADMIN_STATE`, so the CWD the run is
 * launched from never matters.
 */
export const AGENT_MAIN = new URL("../../apps/client/src/main.ts", import.meta.url).pathname;

/** The e2e stub `pi` harness — the agent's inventory reports it (via PI_PATH). */
export const STUB_PI = new URL("./pi", import.meta.url).pathname;

/** Captured daemon lines kept for failure messages (oldest dropped first). */
const RING_CAP = 400;

/** Everything one spawned agent needs; paths are the caller's (cleanup too). */
export interface StartAgentOptions {
  /** `SUBSHELL_AGENT_HOME` — config + daemon.lock live here. */
  home: string;
  /** `--data-dir` — identity keypair + subshell meta/logs on the node. */
  dataDir: string;
  /** `TMUX_TMPDIR` — every tmux server the agent daemonises lands under here. */
  tmuxBase: string;
  /** The plaintext `nsk_…` setup key to redeem (one enrollment). */
  setupKey: string;
  /** Node display name (`--name`). */
  name: string;
  /** Control plane base URL (default: the e2e stack's). */
  server?: string;
}

/** A live `subshell run` daemon + its operator-facing surface. */
export interface RunningAgent {
  /** The detached daemon — its pid IS its process-group id. */
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** SIGTERM the whole group (the daemon + its tmux children), SIGKILL-escalated. */
  stop(): Promise<void>;
  /** Last `n` captured stdout/stderr lines — embed in failure messages. */
  logTail(n?: number): string;
}

/** The agent's env: config isolation + the stub harness + an owned tmux home. */
function agentEnv(o: StartAgentOptions): NodeJS.ProcessEnv {
  // TMUX/TMUX_PANE must not leak in (a suite run from inside a tmux session
  // would otherwise nest the pane server inside the caller's), and
  // TMUX_TMPDIR redirects `-L` sockets into `tmuxBase` so the caller's
  // teardown can enumerate — and kill — every server this agent starts.
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return {
    ...rest,
    SUBSHELL_AGENT_HOME: o.home,
    PI_PATH: STUB_PI,
    TMUX_TMPDIR: o.tmuxBase,
  };
}

/** Runs a one-shot agent invocation (enroll) to completion, output captured. */
async function runOneShot(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [AGENT_MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`subshell ${args[0]} timed out after 60 s\n--- agent output ---\n${out}`));
    }, 60_000);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot spawn subshell ${args[0]}: ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/**
 * Enroll + run a REAL subshell from source (the Phase-3 stand-in for
 * `curl …/install.sh | bash && subshell run`): `enroll` is a one-shot that
 * must exit 0, `run` is the long-lived daemon — spawned `detached` into its
 * own process group so {@link RunningAgent.stop} can SIGTERM the whole tree
 * (bun forks; the tmux servers it daemonises escape the group and are the
 * caller's to sweep via `tmuxBase`).
 */
export async function startAgent(o: StartAgentOptions): Promise<RunningAgent> {
  const env = agentEnv(o);
  const enroll = await runOneShot(
    ["enroll", "--server", o.server ?? BASE_URL, "--key", o.setupKey, "--name", o.name, "--data-dir", o.dataDir],
    env,
  );
  if (enroll.code !== 0) {
    throw new Error(`subshell enroll exited ${enroll.code}\n--- agent output ---\n${enroll.out}`);
  }

  const child = spawn("bun", [AGENT_MAIN, "run"], { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
  // A successful spawn always has a pid; the type just cannot prove it.
  const pgid = child.pid as number;
  const ring: string[] = [];
  let partial = "";
  const push = (chunk: Buffer): void => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      ring.push(line);
      if (ring.length > RING_CAP) ring.shift();
    }
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  // A long-lived child CAN emit 'error' asynchronously (EPIPE on a pipe after
  // the daemon dies, spawn-adjacent failures on some platforms) — with no
  // listener the event throws and takes the whole Playwright worker down.
  // Append to the ring so logTail() shows it and keep going.
  child.on("error", (err) => {
    ring.push(`[stub-agent] run child error: ${err.message}`);
  });
  child.unref();

  const groupAlive = (): boolean => {
    try {
      process.kill(-pgid, 0); // detached → the child pid IS the pgid
      return true;
    } catch {
      return false;
    }
  };

  return {
    child,
    async stop(): Promise<void> {
      for (const sig of ["SIGTERM", "SIGKILL"] as const) {
        if (!groupAlive()) return;
        try {
          process.kill(-pgid, sig);
        } catch {
          return; // ESRCH: already reaped
        }
        // Sliced wait (stack.ts precedent): an awaited timer, not an 'exit'
        // listener — the unref'd child's events may never fire here.
        const deadline = Date.now() + 5_000;
        while (groupAlive() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    },
    logTail(n = 40): string {
      const tail = [...ring];
      if (partial !== "") tail.push(partial);
      return tail.slice(-n).join("\n");
    },
  };
}
