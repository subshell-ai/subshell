/**
 * One ssh child, run to completion, captured, with a deadline that holds.
 *
 * This is the short-RPC sibling of the supervised run loop
 * (`ssh-run-supervisor.ts`): `ssh -G` resolution and the fixed connection
 * probe both finish or die inside a bounded window and their stdout/stderr
 * ARE the answer, so they need capture, not a streaming output store. The
 * deadline posture is `run-bounded.ts`'s (kill AND cancel the readers, then
 * escalate to SIGKILL — killing the child does not close pipes its children
 * hold), simplified to a captured two-stream read because nothing here
 * streams lines; a chatty ssh cannot matter because `-G` and a bounded probe
 * produce a fixed small shape, and the capture caps keep even a pathological
 * child inside the RPC envelope.
 */

import { loginPathEntries } from "../login-path.js";

/** Captured-output cap per stream for the short ssh RPCs (config dumps are small; a runaway is capped, not followed). */
const CAPTURE_CAP_BYTES = 256 * 1024;

/** Escalation gap between SIGTERM and SIGKILL on the deadline path. */
const KILL_GRACE_MS = 2_000;

/** The outcome of one short ssh process. */
export interface SshProcessResult {
  /** Exit code, or null when the process was killed by a signal or never spawned. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The deadline ended the run. */
  timedOut: boolean;
  /** The child could not be spawned at all (no such binary); the message is on stderr. */
  spawnError: boolean;
}

/**
 * Run `argv` to completion or deadline, capturing both streams separately.
 *
 * @param argv - the command; argv[0] must be an absolute path — the callers
 *   resolve `ssh` through the binary ladder BEFORE calling, and nothing here
 *   consults PATH to pick an executable (the §2 "explicit argv" rule).
 * @param env - the COMPLETE child environment; no inheritance, by design
 * @param timeoutMs - hard deadline; the child is terminated at it
 */
export async function runSshProcess(
  argv: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SshProcessResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    }) as Bun.Subprocess<"ignore", "pipe", "pipe">;
  } catch (err) {
    return {
      code: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
      spawnError: true,
    };
  }
  const outReader: CappedReader = proc.stdout.getReader();
  const errReader: CappedReader = proc.stderr.getReader();
  let timedOut = false;
  let escalate: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    timedOut = true;
    proc.kill();
    void outReader.cancel().catch(() => {});
    void errReader.cancel().catch(() => {});
    escalate ??= setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already reaped
      }
    }, KILL_GRACE_MS);
    escalate.unref?.();
  };
  const timer = setTimeout(stop, timeoutMs);
  timer.unref?.();
  try {
    const [stdout, stderr] = await Promise.all([drainCapped(outReader), drainCapped(errReader)]);
    const code = await proc.exited;
    return { code: timedOut ? null : code, stdout, stderr, timedOut, spawnError: false };
  } catch {
    return { code: null, stdout: "", stderr: "", timedOut, spawnError: false };
  } finally {
    clearTimeout(timer);
    if (escalate !== undefined) clearTimeout(escalate);
  }
}

/** The minimal reader shape the drain needs (structural, like `run-bounded.ts`'s — the exact reader class varies by stream generic). */
interface CappedReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/** Read a stream up to the cap; past the cap KEEP DRAINING (a child blocked on a full, unread pipe never exits). */
async function drainCapped(reader: CappedReader): Promise<string> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && kept < CAPTURE_CAP_BYTES) {
        chunks.push(value);
        kept += value.byteLength;
      }
    }
  } catch {
    // cancelled by the deadline: return what arrived
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The PATH value an ssh child gets: this process's PATH plus the login
 * shell's entries (a systemd-launched daemon's PATH is baked at install time
 * and cannot see a Homebrew /usr/local/bin ssh installed later). Exposed so
 * the supervised run's spawn and the short RPCs state the PATH rule once.
 */
export async function sshChildPath(): Promise<string> {
  const entries = [...(process.env.PATH ?? "").split(":"), ...(await loginPathEntries())].filter(Boolean);
  return [...new Set(entries)].join(":");
}
