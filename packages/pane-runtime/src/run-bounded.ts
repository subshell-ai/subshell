import { stripAnsi } from "@internal/backend-errors";
import { loginPathEntries } from "./login-path.js";

/**
 * Running one command to completion under bounds that actually hold.
 *
 * Three callers need the same five guarantees and used to have two copies of
 * them: the agent-CLI installer, the tmux installer, and now every network
 * plugin, which reaches this through {@link PluginHost.run} rather than
 * spawning anything itself. The guarantees are:
 *
 * - **An environment allowlist, not `process.env`.** The control-plane process
 *   holds `BETTER_AUTH_SECRET` and the database path. A vendor's installer and
 *   a third-party plugin's `tailscale status` have equally little business
 *   reading either.
 * - **A PATH a service does not have.** A unit file bakes the PATH of whatever
 *   shell installed it, so a binary installed later is invisible to it. The
 *   login-shell probe (`login-path.ts`) is what closes that, and every spawn
 *   here gets it.
 * - **A deadline that survives an orphan.** Killing a process does not close a
 *   pipe its children still hold, so the readers are cancelled rather than
 *   only the child killed — otherwise `curl … | bash` returns when the orphan
 *   exits rather than at the deadline.
 * - **A size cap that keeps draining.** A child blocked writing to a full,
 *   unread pipe never exits, so the read continues past the cap and discards.
 * - **No stdin.** There is no terminal behind any of these calls, so a command
 *   that prompts must hit the deadline rather than wait forever.
 *
 * What it deliberately does NOT decide is WHAT runs. The two installers pass
 * argv fixed by this repo; {@link PluginHost.run} adds its own refusals
 * (absolute path, no `sudo`) before calling in. A refusal here would have to
 * be true of all three, and "no bare executable name" is false of
 * `["sh", "-c", …]`, which is exactly how an install hint is run.
 */

/**
 * Caps captured output per stream, so a chatty or runaway child cannot grow
 * this process's memory or a response body without bound.
 */
export const OUTPUT_CAP = 64 * 1024;

/** Default deadline. Short, because most callers are probes; installers pass their own. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The ceiling on any caller's deadline.
 *
 * A plugin picks its own `timeoutMs` and a plugin is third-party code, so the
 * number is clamped rather than trusted: without this, one plugin could hold a
 * request open for as long as it liked. Ten minutes is the installer budget,
 * which is the longest legitimate run this mechanism has.
 */
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What a child may read from this process's environment.
 *
 * An allowlist, not `process.env` — see the module docstring. These are the
 * variables a `curl | sh` installer or a vendor CLI legitimately needs: where
 * to put things, how to reach the network, and what locale to speak.
 */
const CHILD_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/**
 * Builds a child's environment: the allowlisted keys that are actually set,
 * any `LC_*` locale override, the caller's extras, then PATH.
 *
 * PATH is applied LAST and so cannot be overridden by `extra`. A caller that
 * could replace it would defeat the login-shell probe above it, and a plugin
 * that could replace it would choose which binaries this process finds.
 */
function childEnv(path: string, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  if (extra) Object.assign(env, extra);
  env.PATH = path;
  return env;
}

/** What {@link runBounded} accepts. Every field has a safe default. */
export interface BoundedRunOptions {
  /** Deadline for the whole run, clamped to ten minutes. What was captured up to it is reported. */
  timeoutMs?: number;
  /** Called per output line, ANSI stripped, stdout and stderr interleaved as they arrive. */
  onLine?: (line: string) => void;
  /**
   * Ends the run early WITHOUT failing it.
   *
   * What an interactive login needs: a command that blocks until a human
   * finishes in a browser has usually already printed the URL, so the caller
   * reads it off {@link onLine} and stops waiting. The child is killed and
   * whatever it printed is reported with `aborted: true`.
   */
  signal?: AbortSignal;
  /** Extra environment on top of the allowlist. Cannot override PATH. */
  env?: Record<string, string>;
  /** Text to write to stdin. Absent closes it, so a prompt cannot hang past the deadline. */
  stdin?: string;
  /** Directories appended to PATH. Production default: the login-shell probe. */
  extraPath?: () => Promise<string[]>;
}

/** What one bounded run produced. A non-zero exit is a RESULT, never a throw. */
export interface BoundedRunResult {
  /** Exit code, or null when the child was signalled or could not be spawned. */
  code: number | null;
  /** Captured stdout, ANSI stripped, capped. */
  stdout: string;
  /** Captured stderr, ANSI stripped, capped. */
  stderr: string;
  /** True when the deadline ended it. */
  timedOut: boolean;
  /** True when {@link BoundedRunOptions.signal} ended it. */
  aborted: boolean;
  /** Wall-clock duration, for the audit metadata that never carries output. */
  durationMs: number;
}

/**
 * Runs one argv to completion under this module's bounds.
 *
 * stdout and stderr are reported SEPARATELY, unlike the installer path that
 * predates this and joins them: a plugin parses `--version`/`--json` off
 * stdout and reads a diagnosis off stderr, and a joined string makes both
 * jobs guesswork. Callers that want them joined join them.
 *
 * A child that cannot be spawned at all (no such file) reports
 * `code: null` with the failure on stderr, rather than throwing — every caller
 * is deciding what to tell a person, and an exception at this layer just moves
 * that decision somewhere with less context.
 * @param argv - the command, the first element being the executable
 * @param options - deadline, line sink, abort signal, extra env, stdin
 */
export async function runBounded(argv: readonly string[], options: BoundedRunOptions = {}): Promise<BoundedRunResult> {
  const started = Date.now();
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const extraPath = options.extraPath ?? loginPathEntries;
  const path = [...(process.env.PATH ?? "").split(":"), ...(await extraPath())].filter(Boolean);

  let timedOut = false;
  let aborted = false;

  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...argv], {
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv([...new Set(path)].join(":"), options.env),
    }) as Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  } catch (err) {
    // The commonest case is a binary that vanished between detection and use.
    // Reporting it as stderr keeps every caller's error handling in one shape.
    return {
      code: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
      aborted: false,
      durationMs: Date.now() - started,
    };
  }

  // Readers are acquired up front, not inside `drain`, so the deadline and the
  // abort can cancel THEM. A stream already locked by a running read loop
  // refuses `stream.cancel()` outright (`TypeError: Cannot cancel a locked
  // ReadableStream`, measured) — the reader holding the lock is the only thing
  // that can release it from out here.
  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();

  /**
   * Ends the run now and stops waiting on the pipes.
   *
   * Killing the child is not enough for a pipeline: `sh -c "a | b"` gives the
   * shell two children holding their own copies of fd 1 and 2, so the pipe
   * never reaches EOF and the reads below would wait for an orphan rather than
   * for the deadline.
   */
  const stop = () => {
    proc.kill();
    void stdoutReader.cancel().catch(() => {});
    void stderrReader.cancel().catch(() => {});
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);

  const onAbort = () => {
    aborted = true;
    stop();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  // An already-aborted signal must not start a child that nothing will stop.
  if (options.signal?.aborted) onAbort();

  try {
    const [stdout, stderr] = await Promise.all([
      drain(stdoutReader, options.onLine),
      drain(stderrReader, options.onLine),
    ]);
    const code = await proc.exited;
    return {
      // A killed child reports a signal rather than a code, and reporting that
      // code would say "it failed with 143" about a deadline we imposed.
      code: timedOut || aborted ? null : code,
      stdout,
      stderr,
      timedOut,
      aborted,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads one stream to a capped string, emitting whole lines as they arrive.
 *
 * Keeps draining past the cap rather than breaking out: a child blocked
 * writing to a full, unread pipe never exits, which would turn a size limit
 * into a hang. Bytes past the cap are counted and discarded, so the marker
 * below can say "there was more" rather than the truncation being silent.
 *
 * On the deadline and abort paths the caller cancels this very reader out from
 * under the loop, which rejects the pending read rather than reporting `done`.
 * That rejection is caught and whatever was captured is returned, which is
 * what lets the call return AT the deadline instead of when the orphan exits.
 */
async function drain(
  reader: { read(): Promise<{ done?: boolean; value?: Uint8Array }> },
  onLine?: (line: string) => void,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let seen = 0;
  // Only assembled when someone is listening, so a caller with no sink pays
  // nothing for the line machinery.
  const decoder = onLine ? new TextDecoder() : null;
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        seen += value.byteLength;
        if (kept < OUTPUT_CAP) {
          chunks.push(value);
          kept += value.byteLength;
        }
        if (decoder && onLine) {
          // Chunks are not lines: one read can split a line mid-word or carry
          // several. `stream: true` keeps a multi-byte character whole across
          // the boundary, and the tail is held until its newline arrives.
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          // ANSI out at the source, so the streamed line and the captured
          // text below agree. A vendor CLI writes for a terminal; a page
          // renders into HTML, where the escapes are mojibake rather than
          // colour.
          for (const line of lines) onLine(stripAnsi(line));
        }
      }
    }
  } catch {
    // Cancelled by the deadline or the abort. Return what we have.
  }
  // A final line with no trailing newline is still a line: a command that dies
  // mid-sentence has usually just said the most useful thing it will say.
  if (onLine && pending.trim() !== "") onLine(stripAnsi(pending));
  const text = stripAnsi(new TextDecoder().decode(Buffer.concat(chunks))).slice(0, OUTPUT_CAP);
  return seen > OUTPUT_CAP ? `${text}\n[truncated]` : text;
}
